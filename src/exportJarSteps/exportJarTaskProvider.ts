// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import glob = require("glob-all");
import globby = require("globby");
import _ = require("lodash");
import { extname, isAbsolute, join, normalize, posix } from "path";
import * as upath from "upath";
import {
    CustomExecution, Event, EventEmitter, Extension, extensions, Pseudoterminal,
    Task, TaskDefinition, TaskProvider, TaskRevealKind, TerminalDimensions, Uri, workspace, WorkspaceFolder,
} from "vscode";
import { createJarFile } from "../exportJarFileCommand";
import { Jdtls } from "../java/jdtls";
import { INodeData } from "../java/nodeData";
import { IClasspathResult } from "./GenerateJarExecutor";
import { IStepMetadata } from "./IStepMetadata";
import { COMPILE_OUTPUT, RUNTIME_DEPENDENCIES_VARIABLE, TEST_DEPENDENCIES_VARIABLE, TESTCOMPILE_OUTPUT } from "./utility";

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
        const task: Task = new Task(defaultDefinition, stepMetadata.workspaceFolder, "export", ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
        task.presentationOptions.reveal = TaskRevealKind.Never;
        return task;
    }

    private tasks: Task[] | undefined;

    public async resolveTask(_task: Task): Promise<Task> {
        const definition: IExportJarTaskDefinition = <any>_task.definition;
        let folder: WorkspaceFolder;
        for (const subFolder of workspace.workspaceFolders) {
            if (subFolder.uri.fsPath === definition.workspacePath) {
                folder = subFolder;
            }
        }
        const stepMetadata: IStepMetadata = {
            entry: undefined,
            workspaceFolder: folder,
            steps: [],
        };
        const task: Task = new Task(definition, folder, definition.workspacePath, ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
        task.presentationOptions.reveal = TaskRevealKind.Never;
        return task;
    }

    public async provideTasks(): Promise<Task[]> {
        if (this.tasks !== undefined) {
            return this.tasks;
        }
        this.tasks = [];
        for (const folder of workspace.workspaceFolders) {
            const projectList: INodeData[] = await Jdtls.getProjects(Uri.parse(folder.uri.toString()).toString());
            const outputList: string[] = [];
            if (_.isEmpty(projectList)) {
                continue;
            } else {
                for (const project of projectList) {
                    outputList.push("${" + COMPILE_OUTPUT + ":" + project.name + "}\\**");
                    outputList.push("${" + TESTCOMPILE_OUTPUT + ":" + project.name + "}\\**");
                }
            }
            outputList.push(RUNTIME_DEPENDENCIES_VARIABLE);
            outputList.push(TEST_DEPENDENCIES_VARIABLE);
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
                steps: [],
            };
            this.tasks.push(new Task(defaultDefinition, folder, folder.name,
                ExportJarTaskProvider.exportJarType, new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                    return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
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
        if (_.isEmpty(this.stepMetadata.outputPath)) {
            this.stepMetadata.outputPath = workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder");
        }
        if (!_.isEmpty(this.stepMetadata.elements)) {
            const dependencies: string[] = [];
            const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
            const extensionApi: any = await extension?.activate();
            const projectList: INodeData[] = await Jdtls.getProjects(Uri.parse(this.stepMetadata.workspaceFolder.uri.toString()).toString());
            const runtimeDependencies: string[] = [];
            const testDependencies: string[] = [];
            const classPathMap: Map<string, string[]> = new Map<string, string[]>();
            for (const project of projectList) {
                const classPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "runtime" });
                const classPathsResolved: string[] = [];
                for (const classpath of classPaths.classpaths) {
                    if (extname(classpath) === ".jar") {
                        runtimeDependencies.push(classpath);
                    } else {
                        classPathsResolved.push(classpath);
                    }
                }
                for (const classpath of classPaths.modulepaths) {
                    if (extname(classpath) === ".jar") {
                        runtimeDependencies.push(classpath);
                    } else {
                        classPathsResolved.push(classpath);
                    }
                }
                classPathMap.set("${" + COMPILE_OUTPUT + ":" + project.name + "}", classPathsResolved);
                const testClassPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "test" });
                const testClassPathsResolved: string[] = [];
                for (const classpath of testClassPaths.classpaths) {
                    if (extname(classpath) === ".jar") {
                        testDependencies.push(classpath);
                    } else {
                        testClassPathsResolved.push(classpath);
                    }
                }
                for (const classpath of testClassPaths.modulepaths) {
                    if (extname(classpath) === ".jar") {
                        testDependencies.push(classpath);
                    } else {
                        testClassPathsResolved.push(classpath);
                    }
                }
                classPathMap.set("${" + TESTCOMPILE_OUTPUT + ":" + project.name + "}", testClassPathsResolved);
            }
            const classPathArray: string[] = [];
            for (const element of this.stepMetadata.elements) {
                if (element === RUNTIME_DEPENDENCIES_VARIABLE) {
                    for (const dependency of runtimeDependencies) {
                        dependencies.push(upath.normalizeSafe(dependency));
                    }
                } else if (element === TEST_DEPENDENCIES_VARIABLE) {
                    for (const dependency of testDependencies) {
                        dependencies.push(upath.normalizeSafe(dependency));
                    }
                } else {
                    for (const key of classPathMap.keys()) {
                        if (element.includes(key)) {
                            for (const value of classPathMap.get(key)) {
                                classPathArray.push(upath.normalizeSafe(this.toAbsolute(element.replace(key, value))));
                            }
                        }
                    }
                    classPathArray.push(upath.normalizeSafe(this.toAbsolute(element)));
                }
            }
            this.stepMetadata.elements = await globby(classPathArray);
            this.stepMetadata.dependencies = await globby(dependencies);
            const test = 1;
        }
        await createJarFile(this.stepMetadata);
        this.closeEmitter.fire();
    }

    public close(): void {

    }

    private toAbsolute(path: string): string {
        if (path.length > 0 && path[0] === "!") {
            const realPath = path.substring(1);
            if (!isAbsolute(realPath)) {
                return "!" + join(this.stepMetadata.workspaceFolder.uri.fsPath, realPath);
            }
        } else {
            if (!isAbsolute(path)) {
                return join(this.stepMetadata.workspaceFolder.uri.fsPath, path);
            }
        }
        return path;
    }

}
