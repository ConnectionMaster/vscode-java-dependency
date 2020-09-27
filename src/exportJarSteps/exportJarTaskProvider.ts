import { pathExistsSync } from "fs-extra";
import _ = require("lodash");
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { extname, join } from "path";
import {
    CustomExecution, Event, EventEmitter, Extension, extensions,
    Pseudoterminal, Task, TaskDefinition, TaskProvider, TaskScope,
    TerminalDimensions, Uri, workspace, WorkspaceFolder,
} from "vscode";
import { buildWorkspace } from "../build";
import { createJarFile, ExportJarStep } from "../exportJarFileCommand";
import { isStandardServerReady } from "../extension";
import { Jdtls } from "../java/jdtls";
import { INodeData } from "../java/nodeData";
import { WorkspaceNode } from "../views/workspaceNode";
import { IClasspathResult } from "./GenerateJarExecutor";
import { IStepMetadata } from "./IStepMetadata";

export class ExportJarTaskProvider implements TaskProvider {

    public static exportJarType: string = "exportjar";

    public static getTask(stepMetadata: IStepMetadata): Task {
        const targetPathSetting: string = workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder");
        const defaultDefinition: IExportJarTaskDefinition = {
            type: ExportJarTaskProvider.exportJarType,
            targetPath: targetPathSetting,
            elements: [],
            manifest: "",
        };
        return new Task(defaultDefinition, stepMetadata.workspaceFolder, "export", ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
    }

    private tasks: Task[] | undefined;

    public async resolveTask(task: Task): Promise<Task> {
        const definition: IExportJarTaskDefinition = <any>task.definition;
        let folder: WorkspaceFolder;
        for (const subfolder of workspace.workspaceFolders) {
            if (subfolder.uri.fsPath === definition.workspacePath) {
                folder = subfolder;
            }
        }
        const stepMetadata: IStepMetadata = {
            entry: undefined,
            workspaceFolder: folder,
            elements: [],
            dependencies: [],
            steps: [],
            backToProjectStep: false,
        };
        if (_.isEmpty(stepMetadata.outputPath)) {
            definition.targetPath = workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder");
        }
        return new Task(definition, folder, definition.workspacePath, ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata); }));
    }

    public async provideTasks(): Promise<Task[]> {
        if (this.tasks !== undefined) {
            return this.tasks;
        }
        this.tasks = [];
        const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
        const extensionApi: any = await extension?.activate();
        for (const folder of workspace.workspaceFolders) {
            const projectPath: string = Uri.parse(folder.uri.toString()).fsPath;
            const projectList: INodeData[] = await Jdtls.getProjects(Uri.parse(folder.uri.toString()).toString());
            const uriSet: Set<string> = new Set<string>();
            const outputList: string[] = [];
            for (const project of projectList) {
                const classPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "runtime" });
                for (let classpath of classPaths.classpaths) {
                    if (extname(classpath) !== ".jar") {
                        if (!uriSet.has(classpath)) {
                            uriSet.add(classpath);
                            if (Uri.parse(classpath).fsPath.startsWith(Uri.parse(projectPath).fsPath)) {
                                classpath = classpath.substring(projectPath.length + 1);
                            }
                            outputList.push(classpath);
                        }
                    }
                }
                const testClassPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "test" });
                for (let classpath of testClassPaths.classpaths) {
                    if (extname(classpath) !== ".jar") {
                        if (!uriSet.has(classpath)) {
                            uriSet.add(classpath);
                            if (Uri.parse(classpath).fsPath.startsWith(Uri.parse(projectPath).fsPath)) {
                                classpath = classpath.substring(projectPath.length + 1);
                            }
                            outputList.push(classpath);
                        }
                    }
                }
            }
            outputList.push("Runtime Dependencies");
            outputList.push("Test Dependencies");
            const defaultDefinition: IExportJarTaskDefinition = {
                type: ExportJarTaskProvider.exportJarType,
                elements: outputList,
                workspacePath: folder.uri.fsPath,
                targetPath: "${workspaceFolder}/${workspaceFolderBasename}.jar",
            };
            const stepMetadata: IStepMetadata = {
                entry: undefined,
                workspaceFolder: folder,
                projectList: await Jdtls.getProjects(folder.uri.toString()),
                elements: [],
                dependencies: [],
                steps: [],
                backToProjectStep: false,
            };
            this.tasks.push(new Task(defaultDefinition, folder, folder.name,
                ExportJarTaskProvider.exportJarType, new CustomExecution(async (): Promise<Pseudoterminal> => {
                    return new ExportJarTaskTerminal(defaultDefinition, stepMetadata);
                })));
        }
        return this.tasks;
    }

}

interface IExportJarTaskDefinition extends TaskDefinition {
    workspacePath?: string;
    elements?: string[];
    manifest?: string;
    targetPath?: string;
}

class ExportJarTaskTerminal implements Pseudoterminal {

    public writeEmitter = new EventEmitter<string>();
    public closeEmitter = new EventEmitter<void>();

    public onDidWrite: Event<string> = this.writeEmitter.event;
    public onDidClose?: Event<void> = this.closeEmitter.event;

    private stepMetadata: IStepMetadata;

    constructor(exportJarTaskDefinition: IExportJarTaskDefinition, stepMetadata: IStepMetadata) {
        this.stepMetadata = stepMetadata;
        this.stepMetadata.manifestPath = exportJarTaskDefinition.manifest;
        this.stepMetadata.outputPath = exportJarTaskDefinition.targetPath;
        this.stepMetadata.elements = exportJarTaskDefinition.elements;
    }

    public async open(initialDimensions: TerminalDimensions | undefined): Promise<void> {
        // elements: handle
        const stepMetadata: IStepMetadata = {
            entry: this.stepMetadata.entry,
            workspaceFolder: this.stepMetadata.workspaceFolder,
            projectList: this.stepMetadata.projectList,
            outputPath: this.stepMetadata.outputPath,
            selectedMainMethod: "",
            elements: this.stepMetadata.elements,
            dependencies: [],
            manifestPath: this.stepMetadata.manifestPath,
            steps: this.stepMetadata.steps,
            backToProjectStep: false,
        };
        const dependencies: string[] = [];
        const elementsResolved: string[] = [];
        const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
        const extensionApi: any = await extension?.activate();
        const projectList: INodeData[] = await Jdtls.getProjects(Uri.parse(stepMetadata.workspaceFolder.uri.toString()).toString());
        const uriSet: Set<string> = new Set<string>();
        for (const element of stepMetadata.elements) {
            if (element === "Runtime Dependencies") {
                for (const project of projectList) {
                    const classPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "runtime" });
                    for (const classpath of classPaths.classpaths) {
                        if (extname(classpath) === ".jar") {
                            if (!uriSet.has(classpath)) {
                                uriSet.add(classpath);
                                dependencies.push(classpath);
                            }
                        }
                    }
                }
            } else if (element === "Test Dependencies") {
                for (const project of projectList) {
                    const classPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "test" });
                    for (const classpath of classPaths.classpaths) {
                        if (extname(classpath) === ".jar") {
                            if (!uriSet.has(classpath)) {
                                uriSet.add(classpath);
                                dependencies.push(classpath);
                            }
                        }
                    }
                }
            } else {
                elementsResolved.push(element);
            }
        }
        if (_.isEmpty(stepMetadata.outputPath)) {
            stepMetadata.outputPath = workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder");
        }
        stepMetadata.elements = elementsResolved;
        stepMetadata.dependencies = dependencies;
        await createJarFile(stepMetadata);
        this.closeEmitter.fire();
    }

    public close(): void {

    }

}
