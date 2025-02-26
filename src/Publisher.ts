import { MetadataCache, TFile, Vault, Notice, getLinkpath, stringifyYaml } from "obsidian";
import DigitalGardenSettings from "src/DigitalGardenSettings";
import { Base64 } from "js-base64";
import { Octokit } from "@octokit/core";
import { arrayBufferToBase64, generateUrlPath, getFileRemotePath, kebabize } from "./utils";
import { vallidatePublishFrontmatter } from "./Validator";
import { excaliDrawBundle, excalidraw } from "./constants";
import { getAPI } from "obsidian-dataview";


export interface IPublisher {
    publish(file: TFile): Promise<boolean>;
    delete(vaultFilePath: string): Promise<boolean>;
    getFilesMarkedForPublishing(): Promise<TFile[]>;
    generateMarkdown(file: TFile): Promise<string>;
}
export default class Publisher {
    vault: Vault;
    metadataCache: MetadataCache;
    settings: DigitalGardenSettings;
    frontmatterRegex: RegExp = /^\s*?---\n([\s\S]*?)\n---/g;

    codeFenceRegex: RegExp = /`(.*?)`/g;
    codeBlockRegex: RegExp = /```.*?\n[\s\S]+?```/g;
    excaliDrawRegex: RegExp = /:\[\[(\d*?,\d*?)\],.*?\]\]/g;

    constructor(vault: Vault, metadataCache: MetadataCache, settings: DigitalGardenSettings) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
    }

    async getFilesMarkedForPublishing(): Promise<TFile[]> {
        const files = this.vault.getMarkdownFiles();
        const filesToPublish = [];
        for (const file of files) {
            try {
                const frontMatter = this.metadataCache.getCache(file.path).frontmatter
                if (frontMatter && frontMatter["dg-publish"] === true) {
                    filesToPublish.push(file);
                }
            } catch {
                //ignore
            }
        }

        return filesToPublish;
    }

    async delete(vaultFilePath: string): Promise<boolean> {
        if (!this.settings.githubRepo) {
            new Notice("Config error: You need to define a GitHub repo in the plugin settings");
            throw {};
        }
        if (!this.settings.githubUserName) {
            new Notice("Config error: You need to define a GitHub Username in the plugin settings");
            throw {};
        }
        if (!this.settings.githubToken) {
            new Notice("Config error: You need to define a GitHub Token in the plugin settings");
            throw {};
        }

        const octokit = new Octokit({ auth: this.settings.githubToken });

        //@ts-expect-error
        const file = app.vault.getAbstractFileByPath(vaultFilePath);
        //@ts-expect-error
        const isHome = app.metadataCache.getFileCache(file).frontmatter["dg-home"];

        const path = getFileRemotePath(vaultFilePath, isHome);

        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Delete note ${vaultFilePath}`,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            if (response.status === 200 && response.data.type === "file") {
                payload.sha = response.data.sha;
            }
        } catch (e) {
            console.log(e)
            return false;
        }

        try {
            const response = await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', payload);
        } catch (e) {
            console.log(e)
            return false
        }
        return true;
    }


    async publish(file: TFile): Promise<boolean> {
        if (!vallidatePublishFrontmatter(this.metadataCache.getCache(file.path).frontmatter)) {
            return false;
        }
        try {
            const text = await this.generateMarkdown(file);
            await this.uploadText(file.path, text);
            return true;
        } catch {
            return false;
        }
    }

    async generateMarkdown(file: TFile): Promise<string> {
        if (file.name.endsWith(".excalidraw.md")) {
            return await this.generateExcalidrawMarkdown(file, true);
        }

        let text = await this.vault.cachedRead(file);
        text = await this.addNoteTitleToFrontmatter(text, file.path, file.basename);
        text = await this.createTranscludedText(text, file.path, 0);
        text = await this.convertDataViews(text, file.path);
        text = await this.convertLinksToFullPath(text, file.path);
        text = await this.removeObsidianComments(text);
        text = await this.createSvgEmbeds(text, file.path);
        text = await this.createBase64Images(text, file.path);
        
        return text.trim();
    }


    async uploadText(filePath: string, content: string) {
        if (!this.settings.githubRepo) {
            new Notice("Config error: You need to define a GitHub repo in the plugin settings");
            throw {};
        }
        if (!this.settings.githubUserName) {
            new Notice("Config error: You need to define a GitHub Username in the plugin settings");
            throw {};
        }
        if (!this.settings.githubToken) {
            new Notice("Config error: You need to define a GitHub Token in the plugin settings");
            throw {};
        }


        const octokit = new Octokit({ auth: this.settings.githubToken });


        const base64Content = Base64.encode(content);
        
        const isHome = content.contains("dg-home: true");
        const path = getFileRemotePath(filePath, isHome);

        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Add note ${filePath}`,
            content: base64Content,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            if (response.status === 200 && response.data.type === "file") {
                payload.sha = response.data.sha;
            }
        } catch (e) {
            console.log(e)
        }

        payload.message = `Update note ${filePath}`;

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', payload);

    }

    stripAwayCodeFences(text: string): string {
        let textToBeProcessed = text;
        textToBeProcessed = textToBeProcessed.replace(this.excaliDrawRegex, '');
        textToBeProcessed = textToBeProcessed.replace(this.codeBlockRegex, '');
        textToBeProcessed = textToBeProcessed.replace(this.codeFenceRegex, '');
        return textToBeProcessed;

    }

    async removeObsidianComments(text: string): Promise<string> {

        const textToBeProcessed = this.stripAwayCodeFences(text);
        const obsidianCommentsRegex: RegExp = /%%.+?%%/gms;
        const obsidianCommentsMatches = textToBeProcessed.match(obsidianCommentsRegex);

        return text.replace(obsidianCommentsRegex, '');
    }

    async addNoteTitleToFrontmatter(text: string, path: string, title: string): Promise<string> {
        const frontmatter = this.metadataCache.getCache(path).frontmatter;

        if (!frontmatter || !frontmatter["position"]) {
            return `---\ntitle: ${title}\n---\n${text}`;
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { position, ...publishedFrontmatter } = frontmatter;
        if (!publishedFrontmatter["title"]) {
            publishedFrontmatter.title = title;
        }

        publishedFrontmatter.layout = `../layouts/Layout.astro`;

        const stringifiedYaml = stringifyYaml(publishedFrontmatter);
        return `---\n${stringifiedYaml.trim()}\n---\n${text.replace(this.frontmatterRegex, '')}`;
    }

    async convertDataViews(text: string, path:string): Promise<string> {
        let replacedText = text;
        const dataViewRegex: RegExp = /```dataview(.+?)```/gsm;
        const dvApi = getAPI();
        const matches = text.matchAll(dataViewRegex);
        if(!matches)return;

        for(const queryBlock of matches){
            try{
                const block = queryBlock[0];
                const query = queryBlock[1];
                const markdown = await dvApi.tryQueryMarkdown(query, path);
                replacedText = replacedText.replace(block, markdown);                
            }catch(e){
                console.log(e)
                new Notice("Unable to render dataview query. Please update the dataview plugin to the latest version.")
                return queryBlock[0];
            }
        }
        return replacedText;

    }

    getProcessedFrontMatter(filePath: string): string {
        const fileFrontMatter = { ...this.metadataCache.getCache(filePath).frontmatter };
        delete fileFrontMatter["position"];

        let publishedFrontMatter: any = { "dg-publish": true };

        publishedFrontMatter = this.addPermalink(fileFrontMatter, publishedFrontMatter, filePath);
        publishedFrontMatter = this.addHomePageTag(fileFrontMatter, publishedFrontMatter);
        publishedFrontMatter = this.addFrontMatterSettings(fileFrontMatter, publishedFrontMatter);

        const fullFrontMatter = publishedFrontMatter?.dgPassFrontmatter ? { ...fileFrontMatter, ...publishedFrontMatter } : publishedFrontMatter;
        const frontMatterString = JSON.stringify(fullFrontMatter);

        return `---\n${frontMatterString}\n---\n`;
    }

    addPermalink(baseFrontMatter: any, newFrontMatter: any, filePath: string) {
        let publishedFrontMatter = { ...newFrontMatter };

        if (baseFrontMatter && baseFrontMatter["dg-permalink"]) {
            publishedFrontMatter["dg-permalink"] = baseFrontMatter["dg-permalink"];
            publishedFrontMatter["permalink"] = baseFrontMatter["dg-permalink"];
            if (!publishedFrontMatter["permalink"].endsWith("/")) {
                publishedFrontMatter["permalink"] += "/";
            }
            if (!publishedFrontMatter["permalink"].startsWith("/")) {
                publishedFrontMatter["permalink"] = "/" + publishedFrontMatter["permalink"];
            }
        } else {
            const noteUrlPath = generateUrlPath(filePath);
            publishedFrontMatter["permalink"] = "/" + noteUrlPath;
        }

        return publishedFrontMatter;
    }

    addHomePageTag(baseFrontMatter: any, newFrontMatter: any) {
        const publishedFrontMatter = { ...newFrontMatter };
        if (baseFrontMatter && baseFrontMatter["dg-home"]) {
            const tags = baseFrontMatter["tags"];
            if (tags) {
                if (typeof (tags) === "string") {
                    publishedFrontMatter["tags"] = [tags, "gardenEntry"];
                } else {
                    publishedFrontMatter["tags"] = [...tags, "gardenEntry"];
                }
            } else {
                publishedFrontMatter["tags"] = "gardenEntry";
            }
        }

        return publishedFrontMatter;
    }

    addFrontMatterSettings(baseFrontMatter: {}, newFrontMatter: {}) {
        if (!baseFrontMatter) {
            baseFrontMatter = {};
        }
        const publishedFrontMatter = { ...newFrontMatter };
        for (const key of Object.keys(this.settings.defaultNoteSettings)) {
            //@ts-ignore
            if (baseFrontMatter[kebabize(key)] !== undefined) {
                //@ts-ignore
                publishedFrontMatter[key] = baseFrontMatter[kebabize(key)]
            }
        }

        if(this.settings.defaultNoteSettings.dgPassFrontmatter){ 
            //@ts-ignore
            publishedFrontMatter.dgPassFrontmatter = this.settings.defaultNoteSettings.dgPassFrontmatter;
        }


        return publishedFrontMatter;
    }

    async convertLinksToFullPath(text: string, filePath: string): Promise<string> {
        let convertedText = text;

        const textToBeProcessed = this.stripAwayCodeFences(text);

        const linkedFileRegex = /\[\[(.*?)\]\]/g;
        const linkedFileMatches = textToBeProcessed.match(linkedFileRegex);

        if (linkedFileMatches) {
            for (const linkMatch of linkedFileMatches) {
                try {

                    const textInsideBrackets = linkMatch.substring(linkMatch.indexOf('[') + 2, linkMatch.lastIndexOf(']') - 1);
                    let [linkedFileName, prettyName] = textInsideBrackets.split("|");

                    prettyName = prettyName || linkedFileName;
                    let headerPath = "";
                    if (linkedFileName.includes("#")) {
                        const headerSplit = linkedFileName.split("#");
                        linkedFileName = headerSplit[0];
                        //currently no support for linking to nested heading with multiple #s
                        headerPath = headerSplit.length > 1 ? `#${headerSplit[1]}` : '';

                    }
                    const fullLinkedFilePath = getLinkpath(linkedFileName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(fullLinkedFilePath, filePath);
                    if (!linkedFile) {
                        convertedText = convertedText.replace(linkMatch, `[[${linkedFileName}${headerPath}|${prettyName}]]`);
                    }
                    if (linkedFile?.extension === "md") {
                        const extensionlessPath = linkedFile.path.substring(0, linkedFile.path.lastIndexOf('.'));
                        convertedText = convertedText.replace(linkMatch, `[[${extensionlessPath}${headerPath}|${prettyName}]]`);
                    }
                } catch (e) {
                    console.log(e);
                    continue;
                }
            }
        }

        return convertedText;

    }

    async createTranscludedText(text: string, filePath: string, currentDepth: number): Promise<string> {
        if (currentDepth >= 4) {
            return text;
        }

        let transcludedText = text;
        const transcludedRegex = /!\[\[(.*?)\]\]/g;
        const transclusionMatches = text.match(transcludedRegex);
        let numberOfExcaliDraws = 0;
        if (transclusionMatches) {
            for (let i = 0; i < transclusionMatches.length; i++) {
                try {
                    const transclusionMatch = transclusionMatches[i];
                    let [tranclusionFileName, headerName] = transclusionMatch.substring(transclusionMatch.indexOf('[') + 2, transclusionMatch.indexOf(']')).split("|");
                    const tranclusionFilePath = getLinkpath(tranclusionFileName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(tranclusionFilePath, filePath);

                    if (linkedFile.name.endsWith(".excalidraw.md")) {
                        let firstDrawing = ++numberOfExcaliDraws === 1;
                        const excaliDrawCode = await this.generateExcalidrawMarkdown(linkedFile, firstDrawing, `${numberOfExcaliDraws}`, false);

                        transcludedText = transcludedText.replace(transclusionMatch, excaliDrawCode);

                    } else if (linkedFile.extension === "md") {

                        let fileText = await this.vault.cachedRead(linkedFile);

						if (tranclusionFileName.includes('#')) { // transcluding header only
							const metadata = this.metadataCache.getFileCache(linkedFile);
							const refHeader = tranclusionFileName.split('#')[1]; 
							const headerInFile = metadata.headings?.find(header => header.heading === refHeader);

							if (headerInFile) {
								const cutTo = metadata.headings[metadata.headings.indexOf(headerInFile) + 1];
								const cutToLine = cutTo?.position?.start?.line;

								fileText = fileText
									.split('\n')
									.slice(headerInFile.position.start.line, cutToLine)
									.join('\n');
							}
						}
                        //Remove frontmatter from transclusion
                        fileText = fileText.replace(this.frontmatterRegex, "");

                        const header = this.generateTransclusionHeader(headerName, linkedFile);

                        const headerSection = header ? `$<div class="markdown-embed-title">\n\n${header}\n\n</div>\n` : '';

                        fileText = `\n<div class="transclusion internal-embed is-loaded"><div class="markdown-embed">\n\n${headerSection}\n\n`
                            + fileText + '\n\n</div></div>\n'

                        if (fileText.match(transcludedRegex)) {
                            fileText = await this.createTranscludedText(fileText, linkedFile.path, currentDepth + 1);
                        }
                        //This should be recursive up to a certain depth
                        transcludedText = transcludedText.replace(transclusionMatch, fileText);
                    }
                } catch {
                    continue;
                }
            }
        }

        return transcludedText;

    }


    async createSvgEmbeds(text: string, filePath: string): Promise<string> {

        //![[image.svg]]
        const transcludedSvgRegex = /!\[\[(.*?)(\.(svg))\|(.*?)\]\]|!\[\[(.*?)(\.(svg))\]\]/g;
        const transcludedSvgs = text.match(transcludedSvgRegex);
        if (transcludedSvgs) {
            for (const svg of transcludedSvgs) {
                try {

                    let [imageName, size] = svg.substring(svg.indexOf('[') + 2, svg.indexOf(']')).split("|");
                    const imagePath = getLinkpath(imageName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const svgText = await this.vault.read(linkedFile);
                    text = text.replace(svg, svgText);
                } catch {
                    continue;
                }
            }
        }

        //!()[image.svg]
        const linkedSvgRegex = /!\[(.*?)\]\((.*?)(\.(svg))\)/g;
        const linkedSvgMatches = text.match(linkedSvgRegex);
        if (linkedSvgMatches) {
            for (const svg of linkedSvgMatches) {
                try {
                    let pathStart = svg.lastIndexOf("(") + 1;
                    let pathEnd = svg.lastIndexOf(")");
                    let imagePath = svg.substring(pathStart, pathEnd);
                    if (imagePath.startsWith("http")) {
                        continue;
                    }

                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const svgText = await this.vault.read(linkedFile);
                    text = text.replace(svg, svgText);
                } catch {
                    continue;
                }
            }
        }

        return text;
    }
    async createBase64Images(text: string, filePath: string): Promise<string> {

        function getExtension(linkedFile: TFile) {
            //Markdown-it will not recognize jpg images. But putting png as the extension makes it work for some reason.
            if (linkedFile.extension === 'jpg' || linkedFile.extension === 'jpeg')
                return 'png'
            return linkedFile.extension;
        }

        let imageText = text;
        //![[image.png]]
        const transcludedImageRegex = /!\[\[(.*?)(\.(png|jpg|jpeg|gif))\|(.*?)\]\]|!\[\[(.*?)(\.(png|jpg|jpeg|gif))\]\]/g;
        const transcludedImageMatches = text.match(transcludedImageRegex);
        if (transcludedImageMatches) {
            for (let i = 0; i < transcludedImageMatches.length; i++) {
                try {
                    const imageMatch = transcludedImageMatches[i];

                    let [imageName, size] = imageMatch.substring(imageMatch.indexOf('[') + 2, imageMatch.indexOf(']')).split("|");
                    const imagePath = getLinkpath(imageName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const image = await this.vault.readBinary(linkedFile);
                    const imageBase64 = arrayBufferToBase64(image)
                    const name = size ? `${imageName}|${size}` : imageName;
                    const imageMarkdown = `![${name}](data:image/${getExtension(linkedFile)};base64,${imageBase64})`;
                    imageText = imageText.replace(imageMatch, imageMarkdown);
                } catch {
                    continue;
                }
            }
        }

        //![](image.png)
        const imageRegex = /!\[(.*?)\]\((.*?)(\.(png|jpg|jpeg|gif))\)/g;
        const imageMatches = text.match(imageRegex);
        if (imageMatches) {
            for (let i = 0; i < imageMatches.length; i++) {
                try {
                    const imageMatch = imageMatches[i];

                    let nameStart = imageMatch.indexOf('[') + 1;
                    let nameEnd = imageMatch.indexOf(']');
                    let imageName = imageMatch.substring(nameStart, nameEnd);

                    let pathStart = imageMatch.lastIndexOf("(") + 1;
                    let pathEnd = imageMatch.lastIndexOf(")");
                    let imagePath = imageMatch.substring(pathStart, pathEnd);
                    if (imagePath.startsWith("http")) {
                        continue;
                    }

                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const image = await this.vault.readBinary(linkedFile);
                    const imageBase64 = arrayBufferToBase64(image)
                    const imageMarkdown = `![${imageName}](data:image/${getExtension(linkedFile)};base64,${imageBase64})`;
                    imageText = imageText.replace(imageMatch, imageMarkdown);
                } catch {
                    continue;
                }
            }
        }

        return imageText;
    }

    generateTransclusionHeader(headerName: string, transcludedFile: TFile) {
        if (!headerName) {
            return headerName;
        }

        const titleVariable = "{{title}}";
        if (headerName && headerName.indexOf(titleVariable) > -1) {
            headerName = headerName.replace(titleVariable, transcludedFile.basename);
        }

        //Defaults to h1
        if (headerName && !headerName.startsWith("#")) {
            headerName = "# " + headerName;
        } else if (headerName) {
            //Add a space to the start of the header if not already there
            const headerParts = headerName.split("#");
            if (!headerParts.last().startsWith(" ")) {
                headerName = headerName.replace(headerParts.last(), " " + headerParts.last());
            }

        }
        return headerName;
    }

    async generateExcalidrawMarkdown(file: TFile, includeExcaliDrawJs: boolean, idAppendage: string = "", includeFrontMatter = true): Promise<string> {
        if (!file.name.endsWith(".excalidraw.md")) return "";

        const fileText = await this.vault.cachedRead(file);
        const frontMatter = await this.getProcessedFrontMatter(file.path);

        const start = fileText.indexOf('```json') + "```json".length;
        const end = fileText.lastIndexOf('```')
        const excaliDrawJson = JSON.parse(fileText.slice(start, end));

        const drawingId = file.name.split(" ").join("_").replace(".", "") + idAppendage;
        let excaliDrawCode = "";
        if (includeExcaliDrawJs) {
            excaliDrawCode += excaliDrawBundle;
        }

        excaliDrawCode += excalidraw(JSON.stringify(excaliDrawJson), drawingId);

        return `${includeFrontMatter ? frontMatter : ''}${excaliDrawCode}`;
    }
}



