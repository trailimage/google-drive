import * as Stream from 'stream';
import {
   is,
   merge,
   Header,
   Cache,
   CachePolicy,
   HttpStatus,
   inferMimeType,
   EventEmitter
} from '@toba/tools';
import { Token, Config as AuthConfig } from '@toba/oauth';
import { google } from 'googleapis';
import {
   GoogleDrive,
   Scope,
   AccessType,
   AuthPrompt,
   GetFileResponse,
   GetFileListResponse,
   GenerateAuthUrlOpts,
   RequestConfig,
   RequestError,
   DriveFile,
   ListFilesParams,
   GetFileParams,
   QuerySpace
} from './types';
// google-auth-library is included by `googleapis` and only needed directly
// for its type information
import { OAuth2Client } from 'google-auth-library';

export interface BasicConfig {
   useCache: boolean;
   /** Cache size in bytes */
   cacheSize: number;
   scope?: Scope | Scope[];
}

export interface ClientConfig extends BasicConfig {
   apiKey: string;
   folderID: string;
   auth: AuthConfig;
}

export interface CacheFile {
   name: string;
}

export enum EventType {
   RefreshTokenError,
   RefreshedAccessToken,
   FoundFile,
   FileNotFound
}

const defaultConfig: BasicConfig = {
   cacheSize: 2048,
   useCache: true,
   scope: [Scope.DriveReadOnly, Scope.DriveMetadataReadOnly]
};

/**
 * http://google.github.io/google-api-nodejs-client/22.2.0/index.html
 */
export class GoogleDriveClient {
   private config: ClientConfig;
   private oauth: OAuth2Client;
   private cache: Cache<CacheFile>;
   private _drive: GoogleDrive;
   events: EventEmitter<EventType, any>;

   constructor(config: ClientConfig) {
      this.config = merge(config, defaultConfig as ClientConfig);
      this.oauth = new google.auth.OAuth2(
         config.auth.clientID,
         config.auth.secret,
         config.auth.callback
      );
      this._drive = null;
      this.events = new EventEmitter<EventType, any>();

      if (this.config.useCache) {
         this.cache = new Cache<CacheFile>({
            maxBytes: this.config.cacheSize
         });
      }

      if (config.auth.token) {
         this.oauth.setCredentials({
            access_token: config.auth.token.access,
            refresh_token: config.auth.token.refresh
         });
      }

      google.options({ auth: this.oauth });
   }

   /**
    * Google's own drive client.
    */
   get drive() {
      if (this._drive === null) {
         this._drive = google.drive('v3') as GoogleDrive;
      }
      return this._drive;
   }

   /**
    * Configured token.
    */
   get token(): Token {
      return this.config.auth.token;
   }

   /**
    * http://google.github.io/google-api-nodejs-client/22.2.0/index.html#authorizing-and-authenticating
    * https://github.com/google/google-auth-library-nodejs#oauth2-client
    */
   get authorizationURL(): string {
      return this.oauth.generateAuthUrl({
         access_type: AccessType.Offline, // gets refresh token
         prompt: AuthPrompt.Consent,
         scope: this.config.scope
      } as GenerateAuthUrlOpts);
   }

   /**
    * https://developers.google.com/identity/protocols/OAuth2WebServer#refresh
    * https://github.com/google/google-auth-library-nodejs#manually-refreshing-access-token
    */
   async ensureAccess() {
      await this.oauth.getRequestMetadata();
      this.events.emit(EventType.RefreshedAccessToken);
   }

   /**
    * List of files matching query parameter.
    *
    * https://developers.google.com/drive/v3/web/search-parameters
    */
   async getFileList(params: ListFilesParams) {
      await this.ensureAccess();
      return new Promise<DriveFile[]>((resolve, reject) => {
         this.drive.files.list(
            params,
            (err: RequestError, res: GetFileListResponse) => {
               if (is.value(err)) {
                  reject(err);
               } else if (res.status != HttpStatus.OK) {
                  reject(`Server returned HTTP status ${res.status}`);
               } else if (
                  is.defined(res, 'data') &&
                  is.defined(res.data, 'files')
               ) {
                  resolve(res.data.files);
               } else {
                  reject('');
               }
            }
         );
      });
   }

   /**
    * Get content of single file.
    *
    * https://developers.google.com/apis-explorer/?hl=en_US#p/drive/v3/drive.files.get
    */
   async getFileData<T>(params: GetFileParams, fileName: string = null) {
      await this.ensureAccess();
      return new Promise<T>((resolve, reject) => {
         this.drive.files.get(
            params,
            (err: RequestError, res: GetFileResponse<T>) => {
               if (is.value(err)) {
                  reject(err);
               } else if (res.status != HttpStatus.OK) {
                  reject(`Server returned HTTP status ${res.status}`);
               } else if (is.defined(res, 'data')) {
                  this.events.emit(EventType.FoundFile, fileName);
                  resolve(res.data as T);
               } else {
                  let msg = 'No data returned for file';
                  if (fileName != null) {
                     msg += ' ' + fileName;
                  }
                  reject(msg);
               }
            }
         );
      });
   }

   //    /**
   //     * Send file content directly to writable stream.
   //     */
   //    streamFile(
   //       params: GetFileParams,
   //       stream: Stream.Writable,
   //       fileName: string = null
   //    ) {
   //       return new Promise<any>((resolve, reject) => {
   //          stream.on('finish', resolve);

   //          this.drive.files
   //             .get(params)
   //             .on('error', (err: RequestError) => {
   //                reject(err);
   //             })
   //             .on('end', () => {
   //                this.events.emit(EventType.FoundFile, fileName);
   //             })
   //             .on('response', (res: any) => {
   //                // response headers are piped directly to the stream so changes
   //                // must happen here
   //                let mimeType = 'application/octet-stream';

   //                if (fileName === null) {
   //                   fileName = new Date().toDateString();
   //                } else {
   //                   mimeType = inferMimeType(fileName);
   //                }

   //                res.headers[
   //                   Header.Content.Disposition.toLowerCase()
   //                ] = `attachment; filename=${fileName}`;
   //                res.headers[Header.Content.Type.toLowerCase()] = mimeType;
   //             })
   //             .pipe(stream);
   //       });
   //    }

   /**
    * Find file with name by creating query and retrieving with ID of first
    * matching item.
    */
   async readFileWithName(fileName: string): Promise<string> {
      await this.ensureAccess();

      const params: ListFilesParams = {
         q: `name = '${fileName}' and '${this.config.folderID}' in parents`,
         spaces: QuerySpace.Drive
      };

      const files = await this.getFileList(params);

      if (files.length == 0) {
         //this.events.emit(EventType.FileNotFound, fileName);
         throw `File not found: “${fileName}”`;
      } else {
         return this.readFileWithID(files[0].id); //, stream);
      }
   }

   /**
    * Download or stream file content. Note that Google downloader uses Request
    * module.
    *
    * https://developers.google.com/drive/v3/web/manage-downloads
    */
   async readFileWithID(
      fileId: string,
      //stream?: Stream.Writable,
      fileName: string = null
   ) {
      await this.ensureAccess();

      const params: GetFileParams = {
         fileId,
         alt: 'media',
         timeout: 10000
      };

      // if (is.value(stream)) {
      //    return this.streamFile(params, stream, fileName);
      // } else {
      return this.getFileData<string>(params, fileName);
      // }
   }
}
