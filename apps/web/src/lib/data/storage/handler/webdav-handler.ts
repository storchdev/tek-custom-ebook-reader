/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookCardProps } from '$lib/components/book-card/book-card-props';
import { ApiStorageHandler, type RequestOptions } from '$lib/data/storage/handler/api-handler';
import {
  BaseStorageHandler,
  FilePrefix,
  type ExternalFile
} from '$lib/data/storage/handler/base-handler';
import { unlockStorageData } from '$lib/data/storage/storage-source-manager';
import { StorageKey } from '$lib/data/storage/storage-types';
import { database, webDavStorageSource$ } from '$lib/data/store';
import pLimit from 'p-limit';

interface WebDavFile extends ExternalFile {
  isCollection: boolean;
}

interface WebDavCredentials {
  baseUrl: string;
  authorization: string;
}

/**
 * Credentials of unlocked WebDAV sources, kept for the lifetime of the tab
 * so the password is asked for once (like OAuth tokens for GDrive/OneDrive).
 */
export const webDavCredentials = new Map<string, WebDavCredentials>();

const propfindBody =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

/**
 * Stores data on any WebDAV server (a self-hosted sync server, Nextcloud, rclone serve webdav, ...).
 * The storage source reuses the remote context fields: clientId is the server url and
 * clientSecret is "username:password".
 *
 * Layout matches the other handlers: <url>/ttu-reader-data/<title>/<prefixed files>.
 * External file ids are absolute urls.
 */
export class WebDavStorageHandler extends ApiStorageHandler {
  constructor(window: Window) {
    super(StorageKey.WEBDAV, window, '');
  }

  setInternalSettings(storageSourceName: string) {
    const newStorageSource = storageSourceName || webDavStorageSource$.getValue();

    if (newStorageSource !== this.storageSourceName) {
      this.clearData();
    }

    this.storageSourceName = newStorageSource;
  }

  async getBookList() {
    if (!this.dataListFetched) {
      database.listLoading$.next(true);

      try {
        await this.ensureTitle();

        const folders = (await this.list(this.rootId)).filter((entry) => entry.isCollection);
        const listLimiter = pLimit(4);

        await Promise.all(
          folders.map((folder) =>
            listLimiter(async () => {
              const title = BaseStorageHandler.desanitizeFilename(folder.name);

              this.titleToId.set(title, folder.id);
              this.setTitleData(
                title,
                (await this.list(folder.id)).filter((entry) => !entry.isCollection)
              );
            })
          )
        ).catch((error) => {
          listLimiter.clearQueue();
          throw error;
        });

        this.dataListFetched = true;
      } catch (error) {
        this.clearData();
        throw error;
      }
    }

    return [...this.titleToBookCard.values()];
  }

  protected async ensureTitle(name = BaseStorageHandler.rootName, parent = '', readOnly = false) {
    if (name === BaseStorageHandler.rootName && this.rootId) {
      return this.rootId;
    }

    const externalId = this.titleToId.get(name);

    if (externalId) {
      return externalId;
    }

    const parentUrl =
      name === BaseStorageHandler.rootName || !parent
        ? (await this.getCredentials()).baseUrl
        : parent;
    const titleId = `${parentUrl}${encodeURIComponent(BaseStorageHandler.sanitizeForFilename(name))}/`;
    let exists = await this.exists(titleId);

    if (!exists && !readOnly) {
      await this.request(titleId, { method: 'MKCOL' }, 'text');
      exists = true;
    }

    if (!exists) {
      if (name === BaseStorageHandler.rootName) {
        throw new Error('Root folder not found');
      }

      return '';
    }

    this.titleToId.set(name, titleId);

    if (name === BaseStorageHandler.rootName) {
      this.rootId = titleId;
    }

    return titleId;
  }

  protected async getExternalFiles(remoteTitleId: string) {
    if (
      (!this.cacheStorageData || !this.dataListFetched) &&
      !this.titleToFiles.has(this.currentContext.title)
    ) {
      const externalFiles = (await this.list(remoteTitleId)).filter((entry) => !entry.isCollection);

      if (externalFiles.length) {
        this.setTitleData(this.currentContext.title, externalFiles);
      }
    }

    return this.titleToFiles.get(this.currentContext.title) || [];
  }

  protected async setRootFiles() {
    if ((!this.cacheStorageData || !this.rootFileListFetched) && !this.rootFiles.size) {
      const rootFiles = (await this.list(this.rootId)).filter((entry) => !entry.isCollection);

      for (let index = 0, { length } = rootFiles; index < length; index += 1) {
        const rootFile = rootFiles[index];

        this.setRootFile(rootFile.name, rootFile);
      }

      this.rootFileListFetched = true;
    }
  }

  protected retrieve(
    file: ExternalFile,
    typeToRetrieve: XMLHttpRequestResponseType,
    progressBase = 1
  ) {
    return this.request(file.id, { trackDownload: true }, typeToRetrieve, progressBase);
  }

  protected async upload(
    folderId: string,
    name: string,
    files: ExternalFile[],
    externalFile: ExternalFile | undefined,
    data: Blob | string | undefined,
    rootFilePrefix?: string,
    progressBase = 0.8
  ): Promise<ExternalFile> {
    const id = `${folderId}${encodeURIComponent(name)}`;

    if (data !== undefined) {
      await this.request(
        id,
        {
          method: 'PUT',
          body: data,
          trackUpload: true,
          headers: {
            'Content-Type':
              typeof data === 'string'
                ? 'application/json'
                : data.type || 'application/octet-stream'
          }
        },
        'text',
        progressBase
      );

      if (externalFile && externalFile.id !== id) {
        await this.executeDelete(externalFile.id).catch(() => {
          // the stale file only carries outdated metadata in its name - ignore
        });
      }
    } else if (externalFile && externalFile.id !== id) {
      await this.request(
        externalFile.id,
        { method: 'MOVE', headers: { Destination: id, Overwrite: 'T' } },
        'text'
      );
    } else if (!externalFile) {
      throw new Error('Renaming requires a remote file');
    }

    if (externalFile) {
      // ids are paths, so they change together with the name
      externalFile.id = id;
    }

    this.updateAfterUpload(id, name, files, externalFile, { isCollection: false }, rootFilePrefix);

    return { id, name };
  }

  protected async executeDelete(id: string) {
    await this.request(id, { method: 'DELETE' }, 'text');
  }

  protected async request(
    url: string,
    options: RequestOptions = {},
    type: XMLHttpRequestResponseType = 'json',
    progressBase = 1
  ): Promise<any> {
    const { authorization } = await this.getCredentials();

    return super.request(
      url,
      {
        ...options,
        skipAuth: true,
        headers: { ...(options.headers || {}), Authorization: authorization }
      },
      type,
      progressBase
    );
  }

  private async getCredentials(): Promise<WebDavCredentials> {
    const cached = webDavCredentials.get(this.storageSourceName);

    if (cached) {
      return cached;
    }

    if (!this.storageSourceName) {
      throw new Error('No WebDAV storage source configured');
    }

    const db = await database.db;
    const storageSource = await db.get('storageSource', this.storageSourceName);

    if (!storageSource) {
      throw new Error(`No storage source with name ${this.storageSourceName} found`);
    }

    const unlockResult = await unlockStorageData(
      storageSource,
      'You are trying to access protected data',
      {
        action: `Enter the correct password for ${this.storageSourceName} to proceed`,
        encryptedData: storageSource.data,
        forwardSecret: true
      }
    );

    if (!unlockResult?.clientId) {
      throw new Error('Unable to unlock required data');
    }

    const credentials = WebDavStorageHandler.toCredentials(
      unlockResult.clientId,
      unlockResult.clientSecret
    );

    webDavCredentials.set(this.storageSourceName, credentials);

    return credentials;
  }

  static toCredentials(url: string, userAndPassword: string): WebDavCredentials {
    const baseUrl = url.trim().endsWith('/') ? url.trim() : `${url.trim()}/`;
    const bytes = new TextEncoder().encode(userAndPassword || '');
    let binary = '';

    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    return { baseUrl, authorization: `Basic ${btoa(binary)}` };
  }

  private async exists(url: string) {
    try {
      await this.request(
        url,
        {
          method: 'PROPFIND',
          headers: { Depth: '0', 'Content-Type': 'application/xml' },
          body: propfindBody
        },
        'text'
      );

      return true;
    } catch (error: any) {
      if (`${error?.message}`.startsWith('Resource not found')) {
        return false;
      }

      throw error;
    }
  }

  private async list(url: string): Promise<WebDavFile[]> {
    const response: string = await this.request(
      url,
      {
        method: 'PROPFIND',
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body: propfindBody
      },
      'text'
    );
    const doc = new DOMParser().parseFromString(response, 'application/xml');
    const ownPath = WebDavStorageHandler.normalizePath(new URL(url).pathname);
    const entries: WebDavFile[] = [];
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');

    for (let index = 0, { length } = responses; index < length; index += 1) {
      const entry = responses[index];
      const href = entry.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent?.trim();

      if (href) {
        const absolute = new URL(href, url);
        const path = WebDavStorageHandler.normalizePath(absolute.pathname);

        if (path !== ownPath) {
          const isCollection = entry.getElementsByTagNameNS('DAV:', 'collection').length > 0;
          const segments = path.split('/');
          const name = decodeURIComponent(segments[segments.length - 1]);

          entries.push({
            id: `${url}${encodeURIComponent(name)}${isCollection ? '/' : ''}`,
            name,
            isCollection
          });
        }
      }
    }

    return entries;
  }

  private static normalizePath(pathname: string) {
    return pathname.replace(/\/+$/, '');
  }

  private setTitleData(title: string, files: ExternalFile[]) {
    if (!files.length) {
      return;
    }

    const bookCard: BookCardProps = {
      id: BaseStorageHandler.getDummyId(),
      title,
      imagePath: '',
      characters: 0,
      lastBookModified: 0,
      lastBookOpen: 0,
      progress: 0,
      lastBookmarkModified: 0,
      annotationCount: 0,
      isPlaceholder: false
    };

    for (let index = 0, { length } = files; index < length; index += 1) {
      const file = files[index];

      if (file.name.startsWith('bookdata_')) {
        const { characters, lastBookModified, lastBookOpen } = BaseStorageHandler.getBookMetadata(
          file.name
        );

        bookCard.characters = characters;
        bookCard.lastBookModified = lastBookModified;
        bookCard.lastBookOpen = lastBookOpen;
      } else if (file.name.startsWith('progress_')) {
        const { progress, lastBookmarkModified } = BaseStorageHandler.getProgressMetadata(
          file.name
        );

        bookCard.progress = progress;
        bookCard.lastBookmarkModified = lastBookmarkModified;
      } else if (file.name.startsWith(FilePrefix.ANNOTATIONS)) {
        bookCard.annotationCount =
          BaseStorageHandler.getAnnotationsMetadata(file.name).annotationCount || 0;
      }
    }

    this.titleToFiles.set(title, files);
    this.titleToBookCard.set(title, bookCard);
  }
}
