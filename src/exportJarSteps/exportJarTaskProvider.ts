// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import glob = require("glob-all");
import _ = require("lodash");
import { extname, isAbsolute, join } from "path";
import {
    CustomExecution, Event, EventEmitter, Extension, extensions,
    Pseudoterminal, Task, TaskDefinition, TaskProvider,
    TerminalDimensions, Uri, workspace, WorkspaceFolder,
} from "vscode";
import { createJarFile } from "../exportJarFileCommand";
import { Jdtls } from "../java/jdtls";
import { INodeData } from "../java/nodeData";
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
            mainMethod: undefined,
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
            classpaths: [],
            steps: [],
            backToProjectStep: false,
        };
        return new Task(definition, folder, definition.workspacePath, ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
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
                            outputList.push(join(classpath, "**"));
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
                            outputList.push(join(classpath, "**"));
                        }
                    }
                }
            }
            outputList.push("RuntimeDependencies");
            outputList.push("TestDependencies");
            const defaultDefinition: IExportJarTaskDefinition = {
                type: ExportJarTaskProvider.exportJarType,
                elements: outputList,
                workspacePath: folder.uri.fsPath,
                mainMethod: "",
                // tslint:disable-next-line: no-invalid-template-strings
                targetPath: "${workspaceFolder}/${workspaceFolderBasename}.jar",
            };
            const stepMetadata: IStepMetadata = {
                entry: undefined,
                workspaceFolder: folder,
                projectList: await Jdtls.getProjects(folder.uri.toString()),
                elements: [],
                dependencies: [],
                classpaths: [],
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
    mainMethod?: string;
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
        this.stepMetadata.mainMethod = exportJarTaskDefinition.mainMethod;
        this.stepMetadata.outputPath = exportJarTaskDefinition.targetPath;
        this.stepMetadata.elements = exportJarTaskDefinition.elements;
    }

    public async open(initialDimensions: TerminalDimensions | undefined): Promise<void> {
        const stepMetadata: IStepMetadata = {
            entry: this.stepMetadata.entry,
            workspaceFolder: this.stepMetadata.workspaceFolder,
            projectList: this.stepMetadata.projectList,
            outputPath: this.stepMetadata.outputPath,
            mainMethod: this.stepMetadata.mainMethod,
            elements: this.stepMetadata.elements,
            dependencies: [],
            classpaths: [],
            steps: this.stepMetadata.steps,
            backToProjectStep: false,
            writeEmitter: this.writeEmitter,
        };
        if (_.isEmpty(stepMetadata.outputPath)) {
            stepMetadata.outputPath = workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder");
        }
        if (!_.isEmpty(stepMetadata.elements)) {
            const dependencies: string[] = [];
            const elementsToGlob: string[] = [];
            const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
            const extensionApi: any = await extension?.activate();
            const projectList: INodeData[] = await Jdtls.getProjects(Uri.parse(stepMetadata.workspaceFolder.uri.toString()).toString());
            const uriSet: Set<string> = new Set<string>();
            const runtimeDependencies: string[] = [];
            const testDependencies: string[] = [];
            const classPaths: string[] = [];
            for (const project of projectList) {
                const classPathsRuntime: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "runtime" });
                for (const classpath of classPathsRuntime.classpaths) {
                    if (!uriSet.has(classpath)) {
                        uriSet.add(classpath);
                        if (extname(classpath) === ".jar") {
                            runtimeDependencies.push(classpath);
                        } else {
                            classPaths.push(classpath);
                        }
                    }
                }
                const classPathsTest: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "test" });
                for (const classpath of classPathsTest.classpaths) {
                    if (!uriSet.has(classpath)) {
                        uriSet.add(classpath);
                        if (extname(classpath) === ".jar") {
                            testDependencies.push(classpath);
                        } else {
                            classPaths.push(classpath);
                        }
                    }
                }
            }
            for (const element of stepMetadata.elements) {
                if (element === "RuntimeDependencies") {
                    for (const dependency of runtimeDependencies) {
                        dependencies.push(dependency);
                    }
                } else if (element === "TestDependencies") {
                    for (const dependency of testDependencies) {
                        dependencies.push(dependency);
                    }
                } else {
                    this.addToArray(elementsToGlob, element);
                }
            }
            stepMetadata.elements = glob.sync(elementsToGlob);
            stepMetadata.dependencies = dependencies;
            //stepMetadata.classpaths = classPaths;
        }
        await createJarFile(stepMetadata);
        this.closeEmitter.fire();
    }

    public close(): void {

    }

    private addToArray(array: string[], path: string): void {
        if (path.length > 0 && path[0] === "!") {
            const realPath = path.substring(1);
            if (isAbsolute(realPath)) {
                array.push("!" + realPath);
            } else {
                array.push("!" + join(this.stepMetadata.workspaceFolder.uri.fsPath, realPath));
            }
        } else {
            if (isAbsolute(path)) {
                array.push(path);
            } else {
                array.push(join(this.stepMetadata.workspaceFolder.uri.fsPath, path));
            }
        }
    }

}
