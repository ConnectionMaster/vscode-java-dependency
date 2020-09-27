// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { EventEmitter, Uri, WorkspaceFolder } from "vscode";
import { ExportJarStep } from "../exportJarFileCommand";
import { INodeData } from "../java/nodeData";

export interface IStepMetadata {
    entry?: INodeData;
    workspaceFolder?: WorkspaceFolder;
    projectList?: INodeData[];
    mainMethod?: string;
    elements: string[];
    dependencies: string[];
    classpaths: IClassPaths[];
    outputPath?: string;
    steps: ExportJarStep[];
    writeEmitter?: EventEmitter<string>;
    backToProjectStep: boolean;
}

export interface IClassPaths {
    source: string;
    destination: string;
}
