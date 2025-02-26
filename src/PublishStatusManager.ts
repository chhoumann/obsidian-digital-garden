import { IDigitalGardenSiteManager } from "./DigitalGardenSiteManager";
import { TFile } from "obsidian";
import { IPublisher } from "./Publisher";
import { generateBlobHash, getFileRemotePath } from "./utils";

export default class PublishStatusManager implements IPublishStatusManager{
    siteManager: IDigitalGardenSiteManager;
    publisher: IPublisher;
    constructor(siteManager: IDigitalGardenSiteManager, publisher:IPublisher ){
       this.siteManager = siteManager;
       this.publisher = publisher;
    }

    async getDeletedNotePaths(): Promise<Array<string>> {
        const remoteNoteHashes = await this.siteManager.getNoteHashes();
        const marked = await this.publisher.getFilesMarkedForPublishing();
        const map = this.getLocalToRemotePathMap(marked);

        return this.generateDeletedNotePaths(remoteNoteHashes, marked, map);
    }

    private generateDeletedNotePaths(remoteNoteHashes: {[key:string]: string}, marked: TFile[], map: {[path: string]: string}): Array<string> {
        const deletedNotePaths: Array<string> = [];
        Object.keys(remoteNoteHashes).forEach(key => {
            if (!marked.find(f => map[f.path] === key || f.path === key)) {
                if(!key.endsWith(".js")){
                    deletedNotePaths.push(key);
                }
            }
        });

        return deletedNotePaths;
    }

    private getLocalToRemotePathMap(localFiles: TFile[]): { [path: string]: string; } { 
        return localFiles.reduce((map, file) => {
            //@ts-expect-error
            const isHome = app.metadataCache.getFileCache(file).frontmatter["dg-home"];
            
            const remoteFileName = getFileRemotePath(file.basename, isHome, false);
            map[file.path] = remoteFileName;
            return map;
        }, {} as { [key: string]: string; });
    }

    async getPublishStatus(): Promise<PublishStatus> {
        const unpublishedNotes: Array<TFile> = [];
        const publishedNotes: Array<TFile> = [];
        const changedNotes: Array<TFile> = [];

        const remoteNoteHashes = await this.siteManager.getNoteHashes();
        const marked = await this.publisher.getFilesMarkedForPublishing();

        const localToRemotePathMap = this.getLocalToRemotePathMap(marked);

        for (const file of marked) {
            const content = await (await this.publisher.generateMarkdown(file));

            const localHash = generateBlobHash(content);
            // Remotehashes are stored with the remote file name, not the local file name, 
            // so we need to map the local file name to the remote file name
            // except for the home note, which is always index.md
            const remoteHash = remoteNoteHashes[localToRemotePathMap[file.path]] ?? remoteNoteHashes[file.path];

            if (!remoteHash) {
                unpublishedNotes.push(file);
            }
            else if (remoteHash === localHash) {
                publishedNotes.push(file);
            }
            else {
                changedNotes.push(file);
            }
        }

        const deletedNotePaths = this.generateDeletedNotePaths(remoteNoteHashes, marked, localToRemotePathMap);

        unpublishedNotes.sort((a, b) => a.path > b.path ? 1 : -1);
        publishedNotes.sort((a, b) => a.path > b.path ? 1 : -1);
        changedNotes.sort((a, b) => a.path > b.path ? 1 : -1);
        deletedNotePaths.sort((a, b) => a > b ? 1 : -1);
        return { unpublishedNotes, publishedNotes, changedNotes, deletedNotePaths };
    }
}

export interface PublishStatus{
    unpublishedNotes: Array<TFile>;
    publishedNotes: Array<TFile>;
    changedNotes: Array<TFile>;
    deletedNotePaths: Array<string>;
}

export interface IPublishStatusManager{
    getPublishStatus(): Promise<PublishStatus>; 
    getDeletedNotePaths(): Promise<Array<string>>;
}