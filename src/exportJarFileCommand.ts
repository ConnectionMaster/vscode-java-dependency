import { commands, tasks } from "vscode";
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { buildWorkspace } from "./build";
import { ExportJarTaskProvider } from "./exportJarSteps/exportJarTaskProvider";
import { GenerateJarExecutor } from "./exportJarSteps/GenerateJarExecutor";
import { IExportJarStepExecutor } from "./exportJarSteps/IExportJarStepExecutor";
import { IStepMetadata } from "./exportJarSteps/IStepMetadata";
import { ResolveJavaProjectExecutor } from "./exportJarSteps/ResolveJavaProjectExecutor";
import { ResolveMainMethodExecutor } from "./exportJarSteps/ResolveMainMethodExecutor";
import { ErrorWithHandler, failMessage, successMessage } from "./exportJarSteps/utility";
import { isStandardServerReady } from "./extension";
import { INodeData } from "./java/nodeData";

export enum ExportJarStep {
    ResolveJavaProject = "RESOLVEJAVAPROJECT",
    ResolveMainMethod = "RESOLVEMAINMETHOD",
    GenerateJar = "GENERATEJAR",
    Finish = "FINISH",
}

const stepMap: Map<ExportJarStep, IExportJarStepExecutor> = new Map<ExportJarStep, IExportJarStepExecutor>([
    [ExportJarStep.ResolveJavaProject, new ResolveJavaProjectExecutor()],
    [ExportJarStep.ResolveMainMethod, new ResolveMainMethodExecutor()],
    [ExportJarStep.GenerateJar, new GenerateJarExecutor()],
]);

let isExportingJar: boolean = false;

export async function createJarFileEntry(node?: INodeData) {
    ResolveJavaProject(node);
}

export async function ResolveJavaProject(node?: INodeData) {
    let sign: boolean = true;
    while (sign) {
        if (!isStandardServerReady() || await buildWorkspace() === false) {
            return;
        }
        if (isExportingJar) {
            failMessage("running");
            return;
        }
        isExportingJar = true;
        const step: ExportJarStep = ExportJarStep.ResolveJavaProject;
        const stepMetadata: IStepMetadata = {
            entry: node,
            elements: [],
            dependencies: [],
            classpaths: [],
            steps: [],
            backToProjectStep: false,
        };
        await stepMap.get(step).execute(stepMetadata);
        await tasks.executeTask(ExportJarTaskProvider.getTask(stepMetadata)); // async
        sign = stepMetadata.backToProjectStep;
        isExportingJar = false;
    }
}

export async function createJarFile(stepMetadata: IStepMetadata) {
    let step: ExportJarStep = ExportJarStep.ResolveMainMethod;
    return new Promise<string>(async (resolve, reject) => {
        while (step !== ExportJarStep.Finish) {
            try {
                step = await stepMap.get(step).execute(stepMetadata);
                if (step === ExportJarStep.ResolveJavaProject) {
                    return reject();
                }
            } catch (err) {
                return reject(err);
            }
        }
        return resolve(stepMetadata.outputPath);
    }).then((message) => {
        successMessage(message);
    }, (err) => {
        if (err instanceof ErrorWithHandler) {
            failMessage(err.message, err.handler);
        } else if (err) {
            failMessage(`${err}`);
        }
    });
}
