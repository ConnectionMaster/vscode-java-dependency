import { pathExistsSync } from "fs-extra";
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { extname, join } from "path";
import {
    CustomExecution, Event, EventEmitter, Extension, extensions,
    Pseudoterminal, Task, TaskDefinition, TaskProvider, TaskScope,
    TerminalDimensions, Uri, workspace,
} from "vscode";
import { buildWorkspace } from "../build";
import { createJarFile, ExportJarStep } from "../exportJarFileCommand";
import { isStandardServerReady } from "../extension";
import { Jdtls } from "../java/jdtls";
import { INodeData } from "../java/nodeData";
import { WorkspaceNode } from "../views/workspaceNode";
import { IClasspathResult } from "./GenerateJarExecutor";
import { IStepMetadata } from "./IStepMetadata";
import { SETTING_BROWSE } from "./utility";

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

    public async provideTasks(): Promise<Task[]> {
        return this.getTasks();
    }

    public resolveTask(task: Task): Task | undefined {
        const definition: IExportJarTaskDefinition = <any>task.definition;
        return undefined;
    }

    private async getTasks(): Promise<Task[]> {
        if (this.tasks !== undefined) {
            return this.tasks;
        }
        this.tasks = [];
        // multi workspace
        const folders = workspace.workspaceFolders;
        if (folders.length === 0) {
            return this.tasks;
        }
        const extension: Extension<any> | undefined = extensions.getExtension("redhat.java");
        const extensionApi: any = await extension?.activate();
        for (const folder of folders) {
            const folderStr: string = Uri.parse(folder.uri.toString()).toString();
            const projectPath: string = Uri.parse(folder.uri.toString()).fsPath;
            const projectList: INodeData[] = await Jdtls.getProjects(folderStr);
            const uriSet: Set<string> = new Set<string>();
            const outputList: string[] = [];
            let runtime: boolean = false;
            let test: boolean = false;
            for (const project of projectList) {
                const classPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "runtime" });
                for (let classpath of classPaths.classpaths) {
                    const extName = extname(classpath);
                    if (extName !== ".jar") {
                        if (!uriSet.has(classpath)) {
                            uriSet.add(classpath);
                            if (Uri.parse(classpath).fsPath.startsWith(Uri.parse(projectPath).fsPath)) {
                                classpath = classpath.substring(projectPath.length + 1);
                            }
                            outputList.push(classpath);
                        }
                    } else {
                        runtime = true;
                    }
                }
                const testClassPaths: IClasspathResult = await extensionApi.getClasspaths(project.uri, { scope: "test" });
                for (let classpath of testClassPaths.classpaths) {
                    const extName = extname(classpath);
                    if (extName !== ".jar") {
                        if (!uriSet.has(classpath)) {
                            uriSet.add(classpath);
                            if (Uri.parse(classpath).fsPath.startsWith(Uri.parse(projectPath).fsPath)) {
                                classpath = classpath.substring(projectPath.length + 1);
                            }
                            outputList.push(classpath);
                        }
                    } else {
                        test = true;
                    }
                }
            }
            if (runtime) {
                outputList.push("Runtime Dependencies");
            }
            if (test) {
                outputList.push("Test Dependencies");
            }
            const defaultDefinition: IExportJarTaskDefinition = {
                type: ExportJarTaskProvider.exportJarType,
                elements: outputList,
                workspacePath: folder.uri.fsPath,
                outputPath: "test",
            };
            this.tasks.push(new Task(defaultDefinition, folder, folder.name,
                ExportJarTaskProvider.exportJarType, new CustomExecution(async (): Promise<Pseudoterminal> => {
                    return new ExportJarTaskTerminal(defaultDefinition, undefined);
                })));
        }
        return this.tasks;
    }

    private getTask(workspacePath: string, workSpace: Uri, elements: string[], projectList: INodeData[],
        manifest: string, definition?: IExportJarTaskDefinition): Task {
        /*if (definition === undefined) {
            definition = {
                type: ExportJarTaskProvider.exportJarType,
                workspacePath,
                workSpace,
                elements,
                projectList,
                manifest,
            };
        }*/
        return new Task(definition, TaskScope.Workspace, workspacePath,
            ExportJarTaskProvider.exportJarType, new CustomExecution(async (): Promise<Pseudoterminal> => {
                return new ExportJarTaskTerminal(definition, undefined);
            }));
    }

}

interface IExportJarTaskDefinition extends TaskDefinition {
    elements?: string[];
    manifest?: string;
    targetPath?: string;
}

class ExportJarTaskTerminal implements Pseudoterminal {

    public writeEmitter = new EventEmitter<string>();
    public closeEmitter = new EventEmitter<void>();

    public onDidWrite: Event<string> = this.writeEmitter.event;
    public onDidClose?: Event<void> = this.closeEmitter.event;

    private exportJarTaskDefinition: IExportJarTaskDefinition;
    private stepMetadata: IStepMetadata;

    constructor(exportJarTaskDefinition: IExportJarTaskDefinition, stepMetadata: IStepMetadata) {
        this.exportJarTaskDefinition = exportJarTaskDefinition;
        this.stepMetadata = stepMetadata;
    }

    public async open(initialDimensions: TerminalDimensions | undefined): Promise<void> {
        const stepMetadata: IStepMetadata = {
            entry: this.stepMetadata.entry,
            workspaceFolder: this.stepMetadata.workspaceFolder,
            projectList: this.stepMetadata.projectList,
            outputPath: this.exportJarTaskDefinition.targetPath,
            selectedMainMethod: "",
            elements: this.exportJarTaskDefinition.elements,
            manifestPath: this.exportJarTaskDefinition.manifest,
            steps: this.stepMetadata.steps,
        };
        await createJarFile(stepMetadata);
        this.closeEmitter.fire();
    }

    public close(): void {

    }

}
