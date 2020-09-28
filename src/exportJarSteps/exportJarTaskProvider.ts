// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import globby = require("globby");
import _ = require("lodash");
import { extname, isAbsolute, join } from "path";
import * as upath from "upath";
import {
    CustomExecution, Event, EventEmitter, Extension, extensions, Pseudoterminal,
    Task, TaskDefinition, TaskFilter, TaskProvider, TaskRevealKind, tasks, TerminalDimensions, Uri, workspace, WorkspaceFolder,
} from "vscode";
import { createJarFile } from "../exportJarFileCommand";
import { Jdtls } from "../java/jdtls";
import { INodeData } from "../java/nodeData";
import { IClasspathResult } from "./GenerateJarExecutor";
import { IClassPaths, IStepMetadata } from "./IStepMetadata";
import { PathTrie } from "./PathTrie";
import { COMPILE_OUTPUT, RUNTIME_DEPENDENCIES_VARIABLE, TEST_DEPENDENCIES_VARIABLE, TESTCOMPILE_OUTPUT, SETTING_ASKUSER, failMessage, IMessageOption } from "./utility";

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
        const task: Task = new Task(defaultDefinition, stepMetadata.workspaceFolder, "DEFAULT_EXPORT", ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
        task.presentationOptions.reveal = TaskRevealKind.Never;
        return task;
    }

    private savedTasks: Task[] | undefined;

    public async resolveTask(_task: Task): Promise<Task> {
        const definition: IExportJarTaskDefinition = <IExportJarTaskDefinition>_task.definition;
        const folder: WorkspaceFolder = <WorkspaceFolder>_task.scope;
        const stepMetadata: IStepMetadata = {
            entry: undefined,
            workspaceFolder: folder,
            steps: [],
        };
        const task: Task = new Task(definition, folder, _task.name, ExportJarTaskProvider.exportJarType,
            new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
            }));
        task.presentationOptions.reveal = TaskRevealKind.Never;
        return task;
    }

    public async provideTasks(): Promise<Task[]> {
        if (this.savedTasks !== undefined) {
            return this.savedTasks;
        }
        this.savedTasks = [];
        for (const folder of workspace.workspaceFolders) {
            const projectList: INodeData[] = await Jdtls.getProjects(folder.uri.toString());
            const outputList: string[] = [];
            if (_.isEmpty(projectList)) {
                continue;
            } else {
                for (const project of projectList) {
                    outputList.push("${" + COMPILE_OUTPUT + ":" + project.name + "}");
                    outputList.push("${" + TESTCOMPILE_OUTPUT + ":" + project.name + "}");
                }
            }
            outputList.push(RUNTIME_DEPENDENCIES_VARIABLE);
            outputList.push(TEST_DEPENDENCIES_VARIABLE);
            const defaultDefinition: IExportJarTaskDefinition = {
                type: ExportJarTaskProvider.exportJarType,
                elements: outputList,
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
            const defaultTask: Task = new Task(defaultDefinition, folder, folder.name,
                ExportJarTaskProvider.exportJarType, new CustomExecution(async (resolvedDefinition: TaskDefinition): Promise<Pseudoterminal> => {
                    return new ExportJarTaskTerminal(resolvedDefinition, stepMetadata);
                }));
            defaultTask.presentationOptions.reveal = TaskRevealKind.Never;
            this.savedTasks.push(defaultTask);
        }
        return this.savedTasks;
    }

}

interface IExportJarTaskDefinition extends TaskDefinition {
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
        const projectList: INodeData[] = await Jdtls.getProjects(this.stepMetadata.workspaceFolder.uri.toString());
        if (_.isEmpty(projectList)) {
            failMessage("No java project found. Please make sure your Java project exists in the workspace.");
            return;
        }
        if (_.isEmpty(this.stepMetadata.outputPath)) {
            if (workspace.getConfiguration("java.dependency.exportjar").get<string>("defaultTargetFolder") === SETTING_ASKUSER) {
                this.stepMetadata.outputPath = SETTING_ASKUSER;
            } else {
                this.stepMetadata.outputPath = join(this.stepMetadata.workspaceFolder.uri.fsPath, this.stepMetadata.workspaceFolder.name + ".jar");
            }
        }
        if (!_.isEmpty(this.stepMetadata.elements)) {
            const dependencies: string[] = [];
            const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
            const extensionApi: any = await extension?.activate();
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
                    let hasVariable: boolean = false;
                    for (const key of classPathMap.keys()) {
                        if (element.includes(key)) {
                            hasVariable = true;
                            for (const value of classPathMap.get(key)) {
                                classPathArray.push(upath.normalizeSafe(this.toAbsolute(element.replace(key, value))));
                            }
                        }
                    }
                    if (hasVariable === false) {
                        classPathArray.push(upath.normalizeSafe(this.toAbsolute(element)));
                    }
                }
            }
            const trie: PathTrie = new PathTrie();
            const fsPathArray: string[] = [];
            for (const classPath of classPathArray) {
                if (classPath.length > 0 && classPath[0] != "!") {
                    const fsPathPosix = upath.normalizeSafe(Uri.file(classPath).fsPath);
                    fsPathArray.push(fsPathPosix);
                    trie.insert(fsPathPosix);
                } else {
                    fsPathArray.push(classPath);
                }
            }
            const globs: string[] = await globby(fsPathArray);
            const sources: IClassPaths[] = [];
            for (const glob of globs) {
                const tireResult: string = trie.find(Uri.file(glob).fsPath);
                if (!_.isEmpty(tireResult)) {
                    const classpath: IClassPaths = {
                        source: glob,
                        destination: glob.substring(tireResult.length + 1),
                    }
                    sources.push(classpath);
                }
                
            }
            this.stepMetadata.sources = sources;
            this.stepMetadata.dependencies = await globby(dependencies);
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
