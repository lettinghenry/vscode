/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { zoomLevelToZoomFactor } from 'vs/platform/windows/common/windows';
import { importEntries, mark } from 'vs/base/common/performance';
import { Workbench } from 'vs/workbench/browser/workbench';
import { NativeWindow } from 'vs/workbench/electron-sandbox/window';
import { setZoomLevel, setZoomFactor, setFullscreen } from 'vs/base/browser/browser';
import { domContentLoaded, addDisposableListener, EventType, scheduleAtNextAnimationFrame } from 'vs/base/browser/dom';
import { URI } from 'vs/base/common/uri';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { reviveWorkspaceIdentifier } from 'vs/platform/workspaces/common/workspaces';
import { ILogService } from 'vs/platform/log/common/log';
import { Schemas } from 'vs/base/common/network';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { Disposable } from 'vs/base/common/lifecycle';
import { IMainProcessService, MainProcessService } from 'vs/platform/ipc/electron-sandbox/mainProcessService';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { FileService } from 'vs/platform/files/common/fileService';
import { IFileService } from 'vs/platform/files/common/files';
import { RemoteFileSystemProvider } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { ISignService } from 'vs/platform/sign/common/sign';
import { FileUserDataProvider } from 'vs/workbench/services/userData/common/fileUserDataProvider';
import { IProductService } from 'vs/platform/product/common/productService';
import product from 'vs/platform/product/common/product';
import { IResourceIdentityService } from 'vs/platform/resource/common/resourceIdentityService';
import { INativeHostService } from 'vs/platform/native/electron-sandbox/native';
import { NativeHostService } from 'vs/platform/native/electron-sandbox/nativeHostService';
import { SimpleConfigurationService, simpleFileSystemProvider, SimpleLogService, SimpleRemoteAgentService, SimpleResourceIdentityService, SimpleSignService, SimpleStorageService, SimpleNativeWorkbenchEnvironmentService, SimpleWorkspaceService } from 'vs/workbench/electron-sandbox/sandbox.simpleservices';
import { INativeWorkbenchConfiguration, INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { RemoteAuthorityResolverService } from 'vs/platform/remote/electron-sandbox/remoteAuthorityResolverService';

class DesktopMain extends Disposable {

	private readonly environmentService = new SimpleNativeWorkbenchEnvironmentService(this.configuration);

	constructor(private configuration: INativeWorkbenchConfiguration) {
		super();

		this.init();
	}

	private init(): void {

		// Massage configuration file URIs
		this.reviveUris();

		// Setup perf
		importEntries(this.environmentService.configuration.perfEntries);

		// Browser config
		const zoomLevel = this.configuration.zoomLevel || 0;
		setZoomFactor(zoomLevelToZoomFactor(zoomLevel));
		setZoomLevel(zoomLevel, true /* isTrusted */);
		setFullscreen(!!this.environmentService.configuration.fullscreen);
	}

	private reviveUris() {
		if (this.environmentService.configuration.folderUri) {
			this.environmentService.configuration.folderUri = URI.revive(this.environmentService.configuration.folderUri);
		}

		if (this.environmentService.configuration.workspace) {
			this.environmentService.configuration.workspace = reviveWorkspaceIdentifier(this.environmentService.configuration.workspace);
		}

		const filesToWait = this.environmentService.configuration.filesToWait;
		const filesToWaitPaths = filesToWait?.paths;
		[filesToWaitPaths, this.environmentService.configuration.filesToOpenOrCreate, this.environmentService.configuration.filesToDiff].forEach(paths => {
			if (Array.isArray(paths)) {
				paths.forEach(path => {
					if (path.fileUri) {
						path.fileUri = URI.revive(path.fileUri);
					}
				});
			}
		});

		if (filesToWait) {
			filesToWait.waitMarkerFileUri = URI.revive(filesToWait.waitMarkerFileUri);
		}
	}

	async open(): Promise<void> {
		const services = await this.initServices();

		await domContentLoaded();
		mark('willStartWorkbench');

		// Create Workbench
		const workbench = new Workbench(document.body, services.serviceCollection, services.logService);

		// Listeners
		this.registerListeners(workbench, services.storageService);

		// Startup
		const instantiationService = workbench.startup();

		// Window
		this._register(instantiationService.createInstance(NativeWindow));

		// Logging
		services.logService.trace('workbench configuration', JSON.stringify(this.environmentService.configuration));
	}

	private registerListeners(workbench: Workbench, storageService: SimpleStorageService): void {

		// Layout
		this._register(addDisposableListener(window, EventType.RESIZE, e => this.onWindowResize(e, true, workbench)));

		// Workbench Lifecycle
		this._register(workbench.onShutdown(() => this.dispose()));
		this._register(workbench.onWillShutdown(event => event.join(storageService.close())));
	}

	private onWindowResize(e: Event, retry: boolean, workbench: Workbench): void {
		if (e.target === window) {
			if (window.document && window.document.body && window.document.body.clientWidth === 0) {
				// TODO@Ben this is an electron issue on macOS when simple fullscreen is enabled
				// where for some reason the window clientWidth is reported as 0 when switching
				// between simple fullscreen and normal screen. In that case we schedule the layout
				// call at the next animation frame once, in the hope that the dimensions are
				// proper then.
				if (retry) {
					scheduleAtNextAnimationFrame(() => this.onWindowResize(e, false, workbench));
				}
				return;
			}

			workbench.layout();
		}
	}

	private async initServices(): Promise<{ serviceCollection: ServiceCollection, logService: ILogService, storageService: SimpleStorageService }> {
		const serviceCollection = new ServiceCollection();

		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		// NOTE: DO NOT ADD ANY OTHER SERVICE INTO THE COLLECTION HERE.
		// CONTRIBUTE IT VIA WORKBENCH.DESKTOP.MAIN.TS AND registerSingleton().
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

		// Main Process
		const mainProcessService = this._register(new MainProcessService(this.configuration.windowId));
		serviceCollection.set(IMainProcessService, mainProcessService);

		// Environment
		serviceCollection.set(IWorkbenchEnvironmentService, this.environmentService);
		serviceCollection.set(INativeWorkbenchEnvironmentService, this.environmentService);

		// Product
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		serviceCollection.set(IProductService, productService);

		// Log
		const logService = new SimpleLogService();
		serviceCollection.set(ILogService, logService);

		// Remote
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService();
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);

		// Sign
		const signService = new SimpleSignService();
		serviceCollection.set(ISignService, signService);

		// Remote Agent
		const remoteAgentService = new SimpleRemoteAgentService();
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		// Native Host
		const nativeHostService = new NativeHostService(this.configuration.windowId, mainProcessService) as INativeHostService;
		serviceCollection.set(INativeHostService, nativeHostService);

		// Files
		const fileService = this._register(new FileService(logService));
		serviceCollection.set(IFileService, fileService);

		fileService.registerProvider(Schemas.file, simpleFileSystemProvider);

		// User Data Provider
		fileService.registerProvider(Schemas.userData, new FileUserDataProvider(URI.file('user-home'), undefined, simpleFileSystemProvider, this.environmentService, logService));

		const connection = remoteAgentService.getConnection();
		if (connection) {
			const remoteFileSystemProvider = this._register(new RemoteFileSystemProvider(remoteAgentService));
			fileService.registerProvider(Schemas.vscodeRemote, remoteFileSystemProvider);
		}

		const resourceIdentityService = new SimpleResourceIdentityService();
		serviceCollection.set(IResourceIdentityService, resourceIdentityService);

		const services = await Promise.all([
			this.createWorkspaceService().then(service => {

				// Workspace
				serviceCollection.set(IWorkspaceContextService, service);

				// Configuration
				serviceCollection.set(IConfigurationService, new SimpleConfigurationService());

				return service;
			}),

			this.createStorageService().then(service => {

				// Storage
				serviceCollection.set(IStorageService, service);

				return service;
			})
		]);

		return { serviceCollection, logService, storageService: services[1] };
	}

	private async createWorkspaceService(): Promise<IWorkspaceContextService> {
		return new SimpleWorkspaceService();
	}

	private async createStorageService(): Promise<SimpleStorageService> {
		return new SimpleStorageService();
	}
}

export function main(configuration: INativeWorkbenchConfiguration): Promise<void> {
	const workbench = new DesktopMain(configuration);

	return workbench.open();
}
