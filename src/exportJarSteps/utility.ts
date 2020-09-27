import { EOL, platform } from "os";
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { commands, QuickInputButtons, QuickPick, QuickPickItem, SaveDialogOptions, Uri, window } from "vscode";
import { sendOperationError } from "vscode-extension-telemetry-wrapper";

export const SETTING_ASKUSER: string = "Browse...";

export function createPickBox<T extends QuickPickItem>(title: string, placeholder: string, items: T[],
                                                       backBtnEnabled: boolean, canSelectMany: boolean = false): QuickPick<T> {
    const pickBox = window.createQuickPick<T>();
    pickBox.title = title;
    pickBox.placeholder = placeholder;
    pickBox.canSelectMany = canSelectMany;
    pickBox.items = items;
    pickBox.ignoreFocusOut = true;
    pickBox.buttons = backBtnEnabled ? [(QuickInputButtons.Back)] : [];
    return pickBox;
}

export async function saveDialog(workSpaceUri: Uri, title: string): Promise<Uri> {
    const options: SaveDialogOptions = {
        saveLabel: title,
        defaultUri: workSpaceUri,
        filters: {
            "Java Archive": ["jar"],
        },
    };
    return Promise.resolve(await window.showSaveDialog(options));
}

export interface IMessageOption {
    title: string;
    command: string;
}

export class ErrorWithHandler extends Error {
    public handler: IMessageOption;
    constructor(message: string, handler: IMessageOption) {
        super(message);
        this.handler = handler;
    }
}

export function failMessage(message: string, option?: IMessageOption) {
    sendOperationError("", "Export Jar", new Error(message));
    if (option === undefined) {
        window.showErrorMessage(message, "Done");
    } else {
        window.showErrorMessage(message, option.title, "Done").then((result) => {
            if (result === option.title) {
                commands.executeCommand(option.command);
            }
        });
    }
}

export function successMessage(outputFileName: string) {
    let openInExplorer: string;
    if (platform() === "win32") {
        openInExplorer = "Reveal in File Explorer";
    } else if (platform() === "darwin") {
        openInExplorer = "Reveal in Finder";
    } else {
        openInExplorer = "Open Containing Folder";
    }
    window.showInformationMessage("Successfully exported jar to" + EOL + outputFileName,
        openInExplorer, "Done").then((messageResult) => {
            if (messageResult === openInExplorer) {
                commands.executeCommand("revealFileInOS", Uri.file(outputFileName));
            }
        });
}
