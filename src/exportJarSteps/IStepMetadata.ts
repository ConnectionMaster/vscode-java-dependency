// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { Uri, WorkspaceFolder } from "vscode";
import { ExportJarStep } from "../exportJarFileCommand";
import { INodeData } from "../java/nodeData";

export interface IStepMetadata {
    entry?: INodeData;
    workspaceFolder?: WorkspaceFolder;
    projectList?: INodeData[];
    selectedMainMethod?: string;
    elements: string[];
    dependencies: string[];
    outputPath?: string;
    manifestPath?: string;
    steps: ExportJarStep[];
    backToProjectStep: boolean;
}
