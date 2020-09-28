// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { sep } from "path";
import { Uri } from "vscode";

export class PathTrie {
    private root: PathTrieNode;

    constructor() {
        this.root = new PathTrieNode(null, null);
    }

    public insert(input: string): void {
        let currentNode: PathTrieNode = this.root;
        const fsPath: string = Uri.parse(input).fsPath;
        const segments: string[] = fsPath.split(sep);

        for (const segment of segments) {
            if (!segment) {
                continue;
            }
            if (!currentNode.children[segment]) {
                currentNode.children[segment] = new PathTrieNode(segment, null);
            }
            currentNode = currentNode.children[segment];
        }

        currentNode.value = input;
    }

    public find(fsPath: string): PathTrieNode | undefined {
        let currentNode = this.root;
        const segments: string[] = fsPath.split(sep);

        for (const segment of segments) {
            if (!segment) {
                continue;
            }
            if (currentNode.children[segment]) {
                currentNode = currentNode.children[segment];
            } else {
                return undefined;
            }
        }

        return currentNode;
    }
}

export class PathTrieNode {
    private _key: string;
    private _value: string;
    private _children: INodeChildren;

    constructor(key: string, value: string) {
        this._key = key;
        this._value = value;
        this._children = {};
    }

    public get children(): INodeChildren {
        return this._children;
    }

    public set value(value: string) {
        this._value = value;
    }

    public get value(): string | undefined {
        return this._value;
    }

}

interface INodeChildren {
    [key: string]: PathTrieNode;
}
