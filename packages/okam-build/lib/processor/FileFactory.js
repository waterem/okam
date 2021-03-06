/**
 * @file File factory that cache all files to process
 * @author sparklewhy@gmail.com
 */

'use strict';

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const Readable = require('stream').Readable;
const {
    FILE_EXT_PROCESSOR,
    isScript: isScriptType,
    isTemplate: isTplType,
    isStyle: isStyleType,
    isJSON: isJsonType,
    isImg: isImgType
} = require('./type');
const {relative} = require('../util').file;

const {DEFAULT_DEP_DIR_NAME, resolveDepModuleNewPath} = require('./helper/npm');

function loadFileContent() {
    if (this._data) {
        return this._data;
    }

    if (!this.rawContent) {
        this.rawContent = fs.readFileSync(this.fullPath);
    }
    return this.rawContent;
}

function updateFileContent(content) {
    this._data = content;
}

function addDeps(deps) {
    this.deps || (this.deps = []);
    if (!Array.isArray(deps)) {
        deps = [deps];
    }

    let currDeps = this.deps;
    deps.forEach(item => {
        if (item && !currDeps.includes(item)) {
            currDeps.push(item);
        }
    });
}

/**
 * 从源文件派生出来的子文件，典型比如 Component 文件可以派生出脚本、模板、样式等子文件
 *
 * @param {Object} file the subFile to add
 */
function addSubFile(file) {
    if (!file) {
        return;
    }

    this.subFiles || (this.subFiles = []);
    if (!this.subFiles.includes(file)) {
        file.isSubFile = true;
        file.owner = this;
        this.subFiles.push(file);
    }
}

function resetFile() {
    if (this.processing) {
        return;
    }

    this.subFiles && (this.subFiles = []);
    this.deps && (this.deps = []);
    this.compiled = false;
    this.refs && (this.refs = null);
    this.analysedDeps && (this.analysedDeps = false);
    this.resolvedModIds && (this.resolvedModIds = null);
    if (this.isAnalysedComponents) {
        this.isAnalysedComponents = false;
    }

    if (this.isSubFile) {
        this.content = this.rawContent;
    }
    else {
        this.rawContent = null;
        this.content = null;
        this.ast && (this.ast = null);
    }
}

function getFileStream() {
    if (!this._data && !this.rawContent) {
        return fs.createReadStream(this.fullPath);
    }

    let content = this._data || this.rawContent;
    let stream = new Readable();
    stream.push(content);
    stream.push(null);
    return stream;
}

/**
 * Create file info object
 *
 * @param {Object} fileInfo the file to create
 * @param {string=} fileInfo.fullPath the file absolute path
 * @param {string=} fileInfo.path the relative path relative to rootDir
 * @param {boolean=} fileInfo.isVirtual whether a virtual file, optional, by default false
 * @param {*=} fileInfo.data the file content, optional
 * @param {string} rootDir the root directory
 * @return {Object}
 */
function createFile(fileInfo, rootDir) {
    let {path: relPath, fullPath, data, isVirtual, isScript, isStyle, isTemplate} = fileInfo;
    if (relPath && !fullPath) {
        fullPath = path.resolve(rootDir, relPath);
    }

    let extname = path.extname(fullPath).slice(1).toLowerCase();
    let vf = {
        processor: FILE_EXT_PROCESSOR[extname],
        dirname: path.dirname(fullPath),
        extname,
        fullPath,
        path: relPath || relative(fullPath, rootDir),
        rawContent: data,
        isVirtual,
        isScript: isScript == null ? isScriptType(extname) : isScript,
        isStyle: isStyle == null ? isStyleType(extname) : isStyle,
        isImg: isImgType(extname),
        isTpl: isTemplate == null ? isTplType(extname) : isTemplate,
        isJson: isJsonType(extname),
        addDeps,
        addSubFile,
        reset: resetFile,
        sourceMap: null
    };

    Object.defineProperties(vf, {
        stream: {
            get: getFileStream
        },
        content: {
            get: loadFileContent,
            set: updateFileContent
        }
    });

    return vf;
}

function isFileExist(file) {
    return !!this._existMap[typeof file === 'string' ? file : file.fullPath];
}

function isMatchFile(file, pattern) {
    if (file === pattern) {
        return true;
    }

    if (pattern instanceof RegExp) {
        return pattern.test(file);
    }

    return false;
}

class FileFactory extends EventEmitter {

    /**
     * Create FileFactory instance
     *
     * @param {Object} options create options
     * @param {string} options.root the file root
     * @param {string} options.rebaseDepDir the rebase dir of the dep file
     * @param {string|RegExp} options.entryStyle the entry style pattern
     * @param {string|RegExp} options.entryScript the entry script pattern
     * @param {string|RegExp} options.projectConfig the projectConfig pattern
     * @param {string} options.componentExtname the component extname
     */
    constructor(options) {
        super();

        this._files = [];
        this._existMap = {};

        let {root, rebaseDepDir} = options;
        this.options = options;
        this.root = root;

        this.initRebaseDepDirConfig(rebaseDepDir);

        Object.defineProperties(this, {
            length: {
                get() {
                    return this._files.length;
                }
            }
        });
    }

    initRebaseDepDirConfig(rebaseDepDir) {
        let result;
        if (rebaseDepDir && typeof rebaseDepDir === 'string') {
            rebaseDepDir = {
                [DEFAULT_DEP_DIR_NAME]: rebaseDepDir
            };
        }

        if (rebaseDepDir && typeof rebaseDepDir === 'object') {
            result = {};
            Object.keys(rebaseDepDir).forEach(originalDir => {
                let newDir = rebaseDepDir[originalDir];
                originalDir = this.getRelativePath(path.join(this.root, originalDir)) + '/';
                newDir = this.getRelativePath(path.join(this.root, newDir)) + '/';
                result[originalDir] = newDir;
            });
        }
        this.rebaseDepDirMap = result;
    }

    getFileList() {
        return this._files;
    }

    getRelativePath(fullPath) {
        return relative(fullPath, this.root);
    }

    resolveFileNewPath(filePath) {
        let rebaseDir = this.rebaseDepDirMap;
        if (!rebaseDir) {
            return;
        }

        let result;
        Object.keys(rebaseDir).some(originalDir => {
            let newDir = rebaseDir[originalDir];
            if (filePath.indexOf(originalDir) === 0) {
                result = resolveDepModuleNewPath(
                    filePath, originalDir, newDir
                );
                return true;
            }

            return false;
        });

        return result;
    }

    /**
     * Add new file
     *
     * @param {string|Object} f the full path or the file object to add
     * @param {boolean=} isUnshift whether unshift the new file to the current
     *        file list
     * @return {Object}
     */
    addFile(f, isUnshift = false) {
        if (typeof f === 'string') {
            let relPath = this.getRelativePath(f);
            let file = this._existMap[relPath];
            if (file) {
                return file;
            }
            f = this.createFile({fullPath: f, path: relPath});
        }
        else {
            f = this.createFile(f);
        }

        let result = isUnshift ? this.unshift(f) : this.push(f);
        if (result) {
            let newPath = this.resolveFileNewPath(f.path);
            if (newPath) {
                f.resolvePath = newPath;
            }

            /**
             * @event addFile
             */
            this.emit('addFile', f);
        }

        return f;
    }

    unshift(f) {
        let existed = this._existMap[f.path];
        if (existed) {
            return false;
        }
        this._existMap[f.path] = f;
        this._files.unshift(f);
        return true;
    }

    push(f) {
        let existed = this._existMap[f.path];
        if (existed) {
            return false;
        }
        this._existMap[f.path] = f;
        this._files.push(f);
        return true;
    }

    getByFullPath(fullPath) {
        let relPath = this.getRelativePath(fullPath);
        return this._existMap[relPath];
    }

    getByPath(relPath) {
        return this._existMap[relPath];
    }

    createFile(f) {
        let file = createFile(f, this.root);
        let {
            entryScript,
            entryStyle,
            projectConfig,
            componentExtname
        } = this.options;

        let filePath = file.path;
        if (isMatchFile(filePath, entryScript)) {
            file.isEntryScript = true;
        }

        if (isMatchFile(filePath, entryStyle)) {
            file.isEntryStyle = true;
        }

        if (isMatchFile(filePath, projectConfig)) {
            file.isProjectConfig = true;
        }

        if (file.extname === componentExtname) {
            file.isComponent = true;
        }

        return file;
    }

    forEach(handler) {
        this._files.forEach(handler);
    }

    some(handler) {
        return this._files.some(handler);
    }

    map(handler) {
        return this._files.map(handler);
    }

    size() {
        return this._files.length;
    }

    hasDep(depFilePath, file, processed) {
        let {path, deps, subFiles} = file;
        if (processed[path]) {
            return false;
        }
        processed[path] = true;

        let depList = deps || [];
        for (let i = 0, len = depList.length; i < len; i++) {
            let depPath = depList[i];
            let depFile = depPath;
            if (typeof depPath === 'string') {
                depFile = this.getByPath(depPath);
            }
            else {
                depPath = depFile.path;
            }

            if (!depFile) {
                continue;
            }

            if (depFilePath === depPath
                || this.hasDep(depFilePath, depFile, processed)
            ) {
                return true;
            }
        }

        return (subFiles || []).some(
            item => this.hasDep(
                depFilePath, item, processed
            )
        );
    }

    getFilesByDep(depFilePath) {
        let files = this._files;
        let result = [];
        let processed = {};
        files.forEach(
            item => {
                if (this.hasDep(depFilePath, item, processed)) {
                    result.push(item);
                }
            }
        );

        return result;
    }
}

FileFactory.prototype.exists = FileFactory.prototype.includes = isFileExist;

FileFactory.createFile = createFile;

module.exports = exports = FileFactory;
