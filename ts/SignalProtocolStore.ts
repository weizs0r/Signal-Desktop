// Copyright 2016-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable class-methods-use-this */
/* eslint-disable no-restricted-syntax */

import PQueue from 'p-queue';
import { isNumber } from 'lodash';
import * as z from 'zod';

import {
  Direction,
  PreKeyRecord,
  PrivateKey,
  PublicKey,
  SenderKeyRecord,
  SessionRecord,
  SignedPreKeyRecord,
} from '@signalapp/signal-client';

import {
  constantTimeEqual,
  fromEncodedBinaryToArrayBuffer,
  typedArrayToArrayBuffer,
} from './Crypto';
import { assert } from './util/assert';
import { isNotNil } from './util/isNotNil';
import { Lock } from './util/Lock';
import { isMoreRecentThan } from './util/timestamp';
import {
  sessionRecordToProtobuf,
  sessionStructureToArrayBuffer,
} from './util/sessionTranslation';
import {
  KeyPairType,
  IdentityKeyType,
  SenderKeyType,
  SessionType,
  SignedPreKeyType,
  OuterSignedPrekeyType,
  PreKeyType,
  UnprocessedType,
  UnprocessedUpdateType,
} from './textsecure/Types.d';

const TIMESTAMP_THRESHOLD = 5 * 1000; // 5 seconds

const VerifiedStatus = {
  DEFAULT: 0,
  VERIFIED: 1,
  UNVERIFIED: 2,
};

function validateVerifiedStatus(status: number): boolean {
  if (
    status === VerifiedStatus.DEFAULT ||
    status === VerifiedStatus.VERIFIED ||
    status === VerifiedStatus.UNVERIFIED
  ) {
    return true;
  }
  return false;
}

const identityKeySchema = z.object({
  id: z.string(),
  publicKey: z.instanceof(ArrayBuffer),
  firstUse: z.boolean(),
  timestamp: z.number().refine((value: number) => value % 1 === 0 && value > 0),
  verified: z.number().refine(validateVerifiedStatus),
  nonblockingApproval: z.boolean(),
});

function validateIdentityKey(attrs: unknown): attrs is IdentityKeyType {
  // We'll throw if this doesn't match
  identityKeySchema.parse(attrs);
  return true;
}

async function normalizeEncodedAddress(
  encodedAddress: string
): Promise<string> {
  const [identifier, deviceId] = window.textsecure.utils.unencodeNumber(
    encodedAddress
  );
  try {
    const conv = window.ConversationController.getOrCreate(
      identifier,
      'private'
    );
    return `${conv.get('id')}.${deviceId}`;
  } catch (e) {
    window.log.error(`could not get conversation for identifier ${identifier}`);
    throw e;
  }
}

type HasIdType<T> = {
  id: T;
};
type CacheEntryType<DBType, HydratedType> =
  | {
      hydrated: false;
      fromDB: DBType;
    }
  | { hydrated: true; fromDB: DBType; item: HydratedType };

type MapFields =
  | 'identityKeys'
  | 'preKeys'
  | 'senderKeys'
  | 'sessions'
  | 'signedPreKeys';

export type SessionTransactionOptions = {
  readonly lock?: Lock;
};

const GLOBAL_LOCK = new Lock();

async function _fillCaches<ID, T extends HasIdType<ID>, HydratedType>(
  object: SignalProtocolStore,
  field: MapFields,
  itemsPromise: Promise<Array<T>>
): Promise<void> {
  const items = await itemsPromise;

  const cache = new Map<ID, CacheEntryType<T, HydratedType>>();
  for (let i = 0, max = items.length; i < max; i += 1) {
    const fromDB = items[i];
    const { id } = fromDB;

    cache.set(id, {
      fromDB,
      hydrated: false,
    });
  }

  window.log.info(`SignalProtocolStore: Finished caching ${field} data`);
  // eslint-disable-next-line no-param-reassign, @typescript-eslint/no-explicit-any
  object[field] = cache as any;
}

export function hydrateSession(session: SessionType): SessionRecord {
  return SessionRecord.deserialize(Buffer.from(session.record, 'base64'));
}
export function hydratePublicKey(identityKey: IdentityKeyType): PublicKey {
  return PublicKey.deserialize(Buffer.from(identityKey.publicKey));
}
export function hydratePreKey(preKey: PreKeyType): PreKeyRecord {
  const publicKey = PublicKey.deserialize(Buffer.from(preKey.publicKey));
  const privateKey = PrivateKey.deserialize(Buffer.from(preKey.privateKey));
  return PreKeyRecord.new(preKey.id, publicKey, privateKey);
}
export function hydrateSignedPreKey(
  signedPreKey: SignedPreKeyType
): SignedPreKeyRecord {
  const createdAt = signedPreKey.created_at;
  const pubKey = PublicKey.deserialize(Buffer.from(signedPreKey.publicKey));
  const privKey = PrivateKey.deserialize(Buffer.from(signedPreKey.privateKey));
  const signature = Buffer.from([]);

  return SignedPreKeyRecord.new(
    signedPreKey.id,
    createdAt,
    pubKey,
    privKey,
    signature
  );
}

export function freezeSession(session: SessionRecord): string {
  return session.serialize().toString('base64');
}
export function freezePublicKey(publicKey: PublicKey): ArrayBuffer {
  return typedArrayToArrayBuffer(publicKey.serialize());
}
export function freezePreKey(preKey: PreKeyRecord): KeyPairType {
  const keyPair = {
    pubKey: typedArrayToArrayBuffer(preKey.publicKey().serialize()),
    privKey: typedArrayToArrayBuffer(preKey.privateKey().serialize()),
  };
  return keyPair;
}
export function freezeSignedPreKey(
  signedPreKey: SignedPreKeyRecord
): KeyPairType {
  const keyPair = {
    pubKey: typedArrayToArrayBuffer(signedPreKey.publicKey().serialize()),
    privKey: typedArrayToArrayBuffer(signedPreKey.privateKey().serialize()),
  };
  return keyPair;
}

// We add a this parameter to avoid an 'implicit any' error on the next line
const EventsMixin = (function EventsMixin(this: unknown) {
  window._.assign(this, window.Backbone.Events);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any) as typeof window.Backbone.EventsMixin;

type SessionCacheEntry = CacheEntryType<SessionType, SessionRecord>;

export class SignalProtocolStore extends EventsMixin {
  // Enums used across the app

  VerifiedStatus = VerifiedStatus;

  // Cached values

  ourIdentityKey?: KeyPairType;

  ourRegistrationId?: number;

  identityKeys?: Map<string, CacheEntryType<IdentityKeyType, PublicKey>>;

  senderKeys?: Map<string, CacheEntryType<SenderKeyType, SenderKeyRecord>>;

  sessions?: Map<string, SessionCacheEntry>;

  sessionLock?: Lock;

  sessionLockQueue: Array<() => void> = [];

  pendingSessions = new Map<string, SessionCacheEntry>();

  pendingUnprocessed = new Map<string, UnprocessedType>();

  preKeys?: Map<number, CacheEntryType<PreKeyType, PreKeyRecord>>;

  signedPreKeys?: Map<
    number,
    CacheEntryType<SignedPreKeyType, SignedPreKeyRecord>
  >;

  senderKeyQueues: Map<string, PQueue> = new Map<string, PQueue>();

  sessionQueues: Map<string, PQueue> = new Map<string, PQueue>();

  async hydrateCaches(): Promise<void> {
    await Promise.all([
      (async () => {
        const item = await window.Signal.Data.getItemById('identityKey');
        this.ourIdentityKey = item ? item.value : undefined;
      })(),
      (async () => {
        const item = await window.Signal.Data.getItemById('registrationId');
        this.ourRegistrationId = item ? item.value : undefined;
      })(),
      _fillCaches<string, IdentityKeyType, PublicKey>(
        this,
        'identityKeys',
        window.Signal.Data.getAllIdentityKeys()
      ),
      _fillCaches<string, SessionType, SessionRecord>(
        this,
        'sessions',
        window.Signal.Data.getAllSessions()
      ),
      _fillCaches<number, PreKeyType, PreKeyRecord>(
        this,
        'preKeys',
        window.Signal.Data.getAllPreKeys()
      ),
      _fillCaches<string, SenderKeyType, SenderKeyRecord>(
        this,
        'senderKeys',
        window.Signal.Data.getAllSenderKeys()
      ),
      _fillCaches<number, SignedPreKeyType, SignedPreKeyRecord>(
        this,
        'signedPreKeys',
        window.Signal.Data.getAllSignedPreKeys()
      ),
    ]);
  }

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return this.ourIdentityKey;
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.ourRegistrationId;
  }

  // PreKeys

  async loadPreKey(keyId: number): Promise<PreKeyRecord | undefined> {
    if (!this.preKeys) {
      throw new Error('loadPreKey: this.preKeys not yet cached!');
    }

    const entry = this.preKeys.get(keyId);
    if (!entry) {
      window.log.error('Failed to fetch prekey:', keyId);
      return undefined;
    }

    if (entry.hydrated) {
      window.log.info('Successfully fetched prekey (cache hit):', keyId);
      return entry.item;
    }

    const item = hydratePreKey(entry.fromDB);
    this.preKeys.set(keyId, {
      hydrated: true,
      fromDB: entry.fromDB,
      item,
    });
    window.log.info('Successfully fetched prekey (cache miss):', keyId);
    return item;
  }

  async storePreKey(keyId: number, keyPair: KeyPairType): Promise<void> {
    if (!this.preKeys) {
      throw new Error('storePreKey: this.preKeys not yet cached!');
    }
    if (this.preKeys.has(keyId)) {
      throw new Error(`storePreKey: prekey ${keyId} already exists!`);
    }

    const fromDB = {
      id: keyId,
      publicKey: keyPair.pubKey,
      privateKey: keyPair.privKey,
    };

    await window.Signal.Data.createOrUpdatePreKey(fromDB);
    this.preKeys.set(keyId, {
      hydrated: false,
      fromDB,
    });
  }

  async removePreKey(keyId: number): Promise<void> {
    if (!this.preKeys) {
      throw new Error('removePreKey: this.preKeys not yet cached!');
    }

    try {
      this.trigger('removePreKey');
    } catch (error) {
      window.log.error(
        'removePreKey error triggering removePreKey:',
        error && error.stack ? error.stack : error
      );
    }

    this.preKeys.delete(keyId);
    await window.Signal.Data.removePreKeyById(keyId);
  }

  async clearPreKeyStore(): Promise<void> {
    if (this.preKeys) {
      this.preKeys.clear();
    }
    await window.Signal.Data.removeAllPreKeys();
  }

  // Signed PreKeys

  async loadSignedPreKey(
    keyId: number
  ): Promise<SignedPreKeyRecord | undefined> {
    if (!this.signedPreKeys) {
      throw new Error('loadSignedPreKey: this.signedPreKeys not yet cached!');
    }

    const entry = this.signedPreKeys.get(keyId);
    if (!entry) {
      window.log.error('Failed to fetch signed prekey:', keyId);
      return undefined;
    }

    if (entry.hydrated) {
      window.log.info('Successfully fetched signed prekey (cache hit):', keyId);
      return entry.item;
    }

    const item = hydrateSignedPreKey(entry.fromDB);
    this.signedPreKeys.set(keyId, {
      hydrated: true,
      item,
      fromDB: entry.fromDB,
    });
    window.log.info('Successfully fetched signed prekey (cache miss):', keyId);
    return item;
  }

  async loadSignedPreKeys(): Promise<Array<OuterSignedPrekeyType>> {
    if (!this.signedPreKeys) {
      throw new Error('loadSignedPreKeys: this.signedPreKeys not yet cached!');
    }

    if (arguments.length > 0) {
      throw new Error('loadSignedPreKeys takes no arguments');
    }

    const entries = Array.from(this.signedPreKeys.values());
    return entries.map(entry => {
      const preKey = entry.fromDB;
      return {
        pubKey: preKey.publicKey,
        privKey: preKey.privateKey,
        created_at: preKey.created_at,
        keyId: preKey.id,
        confirmed: preKey.confirmed,
      };
    });
  }

  // Note that this is also called in update scenarios, for confirming that signed prekeys
  //   have indeed been accepted by the server.
  async storeSignedPreKey(
    keyId: number,
    keyPair: KeyPairType,
    confirmed?: boolean
  ): Promise<void> {
    if (!this.signedPreKeys) {
      throw new Error('storeSignedPreKey: this.signedPreKeys not yet cached!');
    }

    const fromDB = {
      id: keyId,
      publicKey: keyPair.pubKey,
      privateKey: keyPair.privKey,
      created_at: Date.now(),
      confirmed: Boolean(confirmed),
    };

    await window.Signal.Data.createOrUpdateSignedPreKey(fromDB);
    this.signedPreKeys.set(keyId, {
      hydrated: false,
      fromDB,
    });
  }

  async removeSignedPreKey(keyId: number): Promise<void> {
    if (!this.signedPreKeys) {
      throw new Error('removeSignedPreKey: this.signedPreKeys not yet cached!');
    }

    this.signedPreKeys.delete(keyId);
    await window.Signal.Data.removeSignedPreKeyById(keyId);
  }

  async clearSignedPreKeysStore(): Promise<void> {
    if (this.signedPreKeys) {
      this.signedPreKeys.clear();
    }
    await window.Signal.Data.removeAllSignedPreKeys();
  }

  // Sender Key Queue

  async enqueueSenderKeyJob<T>(
    encodedAddress: string,
    task: () => Promise<T>
  ): Promise<T> {
    const senderId = await normalizeEncodedAddress(encodedAddress);
    const queue = this._getSenderKeyQueue(senderId);

    return queue.add<T>(task);
  }

  private _createSenderKeyQueue(): PQueue {
    return new PQueue({ concurrency: 1, timeout: 1000 * 60 * 2 });
  }

  private _getSenderKeyQueue(senderId: string): PQueue {
    const cachedQueue = this.senderKeyQueues.get(senderId);
    if (cachedQueue) {
      return cachedQueue;
    }

    const freshQueue = this._createSenderKeyQueue();
    this.senderKeyQueues.set(senderId, freshQueue);
    return freshQueue;
  }

  // Sender Keys

  private getSenderKeyId(senderKeyId: string, distributionId: string): string {
    return `${senderKeyId}--${distributionId}`;
  }

  async saveSenderKey(
    encodedAddress: string,
    distributionId: string,
    record: SenderKeyRecord
  ): Promise<void> {
    if (!this.senderKeys) {
      throw new Error('saveSenderKey: this.senderKeys not yet cached!');
    }

    try {
      const senderId = await normalizeEncodedAddress(encodedAddress);
      const id = this.getSenderKeyId(senderId, distributionId);

      const fromDB: SenderKeyType = {
        id,
        senderId,
        distributionId,
        data: record.serialize(),
        lastUpdatedDate: Date.now(),
      };

      await window.Signal.Data.createOrUpdateSenderKey(fromDB);

      this.senderKeys.set(id, {
        hydrated: true,
        fromDB,
        item: record,
      });
    } catch (error) {
      const errorString = error && error.stack ? error.stack : error;
      window.log.error(
        `saveSenderKey: failed to save senderKey ${encodedAddress}/${distributionId}: ${errorString}`
      );
    }
  }

  async getSenderKey(
    encodedAddress: string,
    distributionId: string
  ): Promise<SenderKeyRecord | undefined> {
    if (!this.senderKeys) {
      throw new Error('getSenderKey: this.senderKeys not yet cached!');
    }

    try {
      const senderId = await normalizeEncodedAddress(encodedAddress);
      const id = this.getSenderKeyId(senderId, distributionId);

      const entry = this.senderKeys.get(id);
      if (!entry) {
        window.log.error('Failed to fetch sender key:', id);
        return undefined;
      }

      if (entry.hydrated) {
        window.log.info('Successfully fetched signed prekey (cache hit):', id);
        return entry.item;
      }

      const item = SenderKeyRecord.deserialize(entry.fromDB.data);
      this.senderKeys.set(id, {
        hydrated: true,
        item,
        fromDB: entry.fromDB,
      });
      window.log.info('Successfully fetched signed prekey (cache miss):', id);
      return item;
    } catch (error) {
      const errorString = error && error.stack ? error.stack : error;
      window.log.error(
        `getSenderKey: failed to load senderKey ${encodedAddress}/${distributionId}: ${errorString}`
      );
      return undefined;
    }
  }

  // Session Queue

  async enqueueSessionJob<T>(
    encodedAddress: string,
    task: () => Promise<T>
  ): Promise<T> {
    const id = await normalizeEncodedAddress(encodedAddress);
    const queue = this._getSessionQueue(id);

    return queue.add<T>(task);
  }

  private _createSessionQueue(): PQueue {
    return new PQueue({ concurrency: 1, timeout: 1000 * 60 * 2 });
  }

  private _getSessionQueue(id: string): PQueue {
    const cachedQueue = this.sessionQueues.get(id);
    if (cachedQueue) {
      return cachedQueue;
    }

    const freshQueue = this._createSessionQueue();
    this.sessionQueues.set(id, freshQueue);
    return freshQueue;
  }

  // Sessions

  // Re-entrant session transaction routine. Only one session transaction could
  // be running at the same time.
  //
  // While in transaction:
  //
  // - `storeSession()` adds the updated session to the `pendingSessions`
  // - `loadSession()` looks up the session first in `pendingSessions` and only
  //   then in the main `sessions` store
  //
  // When transaction ends:
  //
  // - successfully: pending session stores are batched into the database
  // - with an error: pending session stores are reverted
  async sessionTransaction<T>(
    name: string,
    body: () => Promise<T>,
    lock: Lock = GLOBAL_LOCK
  ): Promise<T> {
    // Allow re-entering from LibSignalStores
    const isNested = this.sessionLock === lock;
    if (this.sessionLock && !isNested) {
      window.log.info(`sessionTransaction(${name}): sessions locked, waiting`);
      await new Promise<void>(resolve => this.sessionLockQueue.push(resolve));
    }

    if (!isNested) {
      if (lock !== GLOBAL_LOCK) {
        window.log.info(`sessionTransaction(${name}): enter`);
      }
      this.sessionLock = lock;
    }

    let result: T;
    try {
      result = await body();
    } catch (error) {
      if (!isNested) {
        await this.revertSessions(name, error);
        this.releaseSessionLock();
      }
      throw error;
    }

    if (!isNested) {
      await this.commitSessions(name);
      this.releaseSessionLock();
    }

    return result;
  }

  private async commitSessions(name: string): Promise<void> {
    const { pendingSessions, pendingUnprocessed } = this;

    if (pendingSessions.size === 0 && pendingUnprocessed.size === 0) {
      return;
    }

    window.log.info(
      `commitSessions(${name}): pending sessions ${pendingSessions.size} ` +
        `pending unprocessed ${pendingUnprocessed.size}`
    );

    this.pendingSessions = new Map();
    this.pendingUnprocessed = new Map();

    // Commit both unprocessed and sessions in the same database transaction
    // to unroll both on error.
    await window.Signal.Data.commitSessionsAndUnprocessed({
      sessions: Array.from(pendingSessions.values()).map(
        ({ fromDB }) => fromDB
      ),
      unprocessed: Array.from(pendingUnprocessed.values()),
    });

    const { sessions } = this;
    assert(sessions !== undefined, "Can't commit unhydrated storage");

    // Apply changes to in-memory storage after successful DB write.
    pendingSessions.forEach((value, key) => {
      sessions.set(key, value);
    });
  }

  private async revertSessions(name: string, error: Error): Promise<void> {
    window.log.info(
      `revertSessions(${name}): pending size ${this.pendingSessions.size}`,
      error && error.stack
    );
    this.pendingSessions.clear();
    this.pendingUnprocessed.clear();
  }

  private releaseSessionLock(): void {
    this.sessionLock = undefined;
    const next = this.sessionLockQueue.shift();
    if (next) {
      next();
    }
  }

  async loadSession(
    encodedAddress: string,
    { lock }: SessionTransactionOptions = {}
  ): Promise<SessionRecord | undefined> {
    return this.sessionTransaction(
      'loadSession',
      async () => {
        if (!this.sessions) {
          throw new Error('loadSession: this.sessions not yet cached!');
        }

        if (encodedAddress === null || encodedAddress === undefined) {
          throw new Error('loadSession: encodedAddress was undefined/null');
        }

        try {
          const id = await normalizeEncodedAddress(encodedAddress);
          const map = this.pendingSessions.has(id)
            ? this.pendingSessions
            : this.sessions;
          const entry = map.get(id);

          if (!entry) {
            return undefined;
          }

          if (entry.hydrated) {
            return entry.item;
          }

          const item = await this._maybeMigrateSession(entry.fromDB);
          map.set(id, {
            hydrated: true,
            item,
            fromDB: entry.fromDB,
          });
          return item;
        } catch (error) {
          const errorString = error && error.stack ? error.stack : error;
          window.log.error(
            `loadSession: failed to load session ${encodedAddress}: ${errorString}`
          );
          return undefined;
        }
      },
      lock
    );
  }

  private async _maybeMigrateSession(
    session: SessionType
  ): Promise<SessionRecord> {
    // Already migrated, return record directly
    if (session.version === 2) {
      return hydrateSession(session);
    }

    // Not yet converted, need to translate to new format
    if (session.version !== undefined) {
      throw new Error('_maybeMigrateSession: Unknown session version type!');
    }

    const keyPair = await this.getIdentityKeyPair();
    if (!keyPair) {
      throw new Error('_maybeMigrateSession: No identity key for ourself!');
    }

    const localRegistrationId = await this.getLocalRegistrationId();
    if (!isNumber(localRegistrationId)) {
      throw new Error('_maybeMigrateSession: No registration id for ourself!');
    }

    const localUserData = {
      identityKeyPublic: keyPair.pubKey,
      registrationId: localRegistrationId,
    };

    window.log.info(
      `_maybeMigrateSession: Migrating session with id ${session.id}`
    );
    const sessionProto = sessionRecordToProtobuf(
      JSON.parse(session.record),
      localUserData
    );
    return SessionRecord.deserialize(
      Buffer.from(sessionStructureToArrayBuffer(sessionProto))
    );
  }

  async storeSession(
    encodedAddress: string,
    record: SessionRecord,
    { lock }: SessionTransactionOptions = {}
  ): Promise<void> {
    await this.sessionTransaction(
      'storeSession',
      async () => {
        if (!this.sessions) {
          throw new Error('storeSession: this.sessions not yet cached!');
        }

        if (encodedAddress === null || encodedAddress === undefined) {
          throw new Error('storeSession: encodedAddress was undefined/null');
        }
        const unencoded = window.textsecure.utils.unencodeNumber(
          encodedAddress
        );
        const deviceId = parseInt(unencoded[1], 10);

        try {
          const id = await normalizeEncodedAddress(encodedAddress);
          const fromDB = {
            id,
            version: 2,
            conversationId: window.textsecure.utils.unencodeNumber(id)[0],
            deviceId,
            record: record.serialize().toString('base64'),
          };

          const newSession = {
            hydrated: true,
            fromDB,
            item: record,
          };

          this.pendingSessions.set(id, newSession);
        } catch (error) {
          const errorString = error && error.stack ? error.stack : error;
          window.log.error(
            `storeSession: Save failed fo ${encodedAddress}: ${errorString}`
          );
          throw error;
        }
      },
      lock
    );
  }

  async getDeviceIds(identifier: string): Promise<Array<number>> {
    return this.sessionTransaction('getDeviceIds', async () => {
      if (!this.sessions) {
        throw new Error('getDeviceIds: this.sessions not yet cached!');
      }
      if (identifier === null || identifier === undefined) {
        throw new Error('getDeviceIds: identifier was undefined/null');
      }

      try {
        const id = window.ConversationController.getConversationId(identifier);
        if (!id) {
          throw new Error(
            `getDeviceIds: No conversationId found for identifier ${identifier}`
          );
        }

        const allSessions = this._getAllSessions();
        const entries = allSessions.filter(
          session => session.fromDB.conversationId === id
        );
        const openIds = await Promise.all(
          entries.map(async entry => {
            if (entry.hydrated) {
              const record = entry.item;
              if (record.hasCurrentState()) {
                return entry.fromDB.deviceId;
              }

              return undefined;
            }

            const record = await this._maybeMigrateSession(entry.fromDB);
            if (record.hasCurrentState()) {
              return entry.fromDB.deviceId;
            }

            return undefined;
          })
        );

        return openIds.filter(isNotNil);
      } catch (error) {
        window.log.error(
          `getDeviceIds: Failed to get device ids for identifier ${identifier}`,
          error && error.stack ? error.stack : error
        );
      }

      return [];
    });
  }

  async removeSession(encodedAddress: string): Promise<void> {
    return this.sessionTransaction('removeSession', async () => {
      if (!this.sessions) {
        throw new Error('removeSession: this.sessions not yet cached!');
      }

      window.log.info('removeSession: deleting session for', encodedAddress);
      try {
        const id = await normalizeEncodedAddress(encodedAddress);
        await window.Signal.Data.removeSessionById(id);
        this.sessions.delete(id);
        this.pendingSessions.delete(id);
      } catch (e) {
        window.log.error(
          `removeSession: Failed to delete session for ${encodedAddress}`
        );
      }
    });
  }

  async removeAllSessions(identifier: string): Promise<void> {
    return this.sessionTransaction('removeAllSessions', async () => {
      if (!this.sessions) {
        throw new Error('removeAllSessions: this.sessions not yet cached!');
      }

      if (identifier === null || identifier === undefined) {
        throw new Error('removeAllSessions: identifier was undefined/null');
      }

      window.log.info('removeAllSessions: deleting sessions for', identifier);

      const id = window.ConversationController.getConversationId(identifier);

      const entries = Array.from(this.sessions.values());

      for (let i = 0, max = entries.length; i < max; i += 1) {
        const entry = entries[i];
        if (entry.fromDB.conversationId === id) {
          this.sessions.delete(entry.fromDB.id);
          this.pendingSessions.delete(entry.fromDB.id);
        }
      }

      await window.Signal.Data.removeSessionsByConversation(identifier);
    });
  }

  private async _archiveSession(entry?: SessionCacheEntry) {
    if (!entry) {
      return;
    }

    await this.enqueueSessionJob(entry.fromDB.id, async () => {
      const item = entry.hydrated
        ? entry.item
        : await this._maybeMigrateSession(entry.fromDB);

      if (!item.hasCurrentState()) {
        return;
      }

      item.archiveCurrentState();

      await this.storeSession(entry.fromDB.id, item);
    });
  }

  async archiveSession(encodedAddress: string): Promise<void> {
    return this.sessionTransaction('archiveSession', async () => {
      if (!this.sessions) {
        throw new Error('archiveSession: this.sessions not yet cached!');
      }

      window.log.info(`archiveSession: session for ${encodedAddress}`);

      const id = await normalizeEncodedAddress(encodedAddress);

      const entry = this.pendingSessions.get(id) || this.sessions.get(id);

      await this._archiveSession(entry);
    });
  }

  async archiveSiblingSessions(encodedAddress: string): Promise<void> {
    return this.sessionTransaction('archiveSiblingSessions', async () => {
      if (!this.sessions) {
        throw new Error(
          'archiveSiblingSessions: this.sessions not yet cached!'
        );
      }

      window.log.info(
        'archiveSiblingSessions: archiving sibling sessions for',
        encodedAddress
      );

      const id = await normalizeEncodedAddress(encodedAddress);
      const [identifier, deviceId] = window.textsecure.utils.unencodeNumber(id);
      const deviceIdNumber = parseInt(deviceId, 10);

      const allEntries = this._getAllSessions();
      const entries = allEntries.filter(
        entry =>
          entry.fromDB.conversationId === identifier &&
          entry.fromDB.deviceId !== deviceIdNumber
      );

      await Promise.all(
        entries.map(async entry => {
          await this._archiveSession(entry);
        })
      );
    });
  }

  async archiveAllSessions(identifier: string): Promise<void> {
    return this.sessionTransaction('archiveAllSessions', async () => {
      if (!this.sessions) {
        throw new Error('archiveAllSessions: this.sessions not yet cached!');
      }

      window.log.info(
        'archiveAllSessions: archiving all sessions for',
        identifier
      );

      const id = window.ConversationController.getConversationId(identifier);

      const allEntries = this._getAllSessions();
      const entries = allEntries.filter(
        entry => entry.fromDB.conversationId === id
      );

      await Promise.all(
        entries.map(async entry => {
          await this._archiveSession(entry);
        })
      );
    });
  }

  async clearSessionStore(): Promise<void> {
    return this.sessionTransaction('clearSessionStore', async () => {
      if (this.sessions) {
        this.sessions.clear();
      }
      this.pendingSessions.clear();
      await window.Signal.Data.removeAllSessions();
    });
  }

  // Identity Keys

  getIdentityRecord(identifier: string): IdentityKeyType | undefined {
    if (!this.identityKeys) {
      throw new Error('getIdentityRecord: this.identityKeys not yet cached!');
    }

    try {
      const id = window.ConversationController.getConversationId(identifier);
      if (!id) {
        throw new Error(
          `getIdentityRecord: No conversation id for identifier ${identifier}`
        );
      }

      const entry = this.identityKeys.get(id);
      if (!entry) {
        return undefined;
      }

      return entry.fromDB;
    } catch (e) {
      window.log.error(
        `getIdentityRecord: Failed to get identity record for identifier ${identifier}`
      );
      return undefined;
    }
  }

  async isTrustedIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    direction: number
  ): Promise<boolean> {
    if (!this.identityKeys) {
      throw new Error('getIdentityRecord: this.identityKeys not yet cached!');
    }

    if (encodedAddress === null || encodedAddress === undefined) {
      throw new Error('isTrustedIdentity: encodedAddress was undefined/null');
    }
    const identifier = window.textsecure.utils.unencodeNumber(
      encodedAddress
    )[0];
    const ourNumber = window.textsecure.storage.user.getNumber();
    const ourUuid = window.textsecure.storage.user.getUuid();
    const isOurIdentifier =
      (ourNumber && identifier === ourNumber) ||
      (ourUuid && identifier === ourUuid);

    const identityRecord = this.getIdentityRecord(identifier);

    if (isOurIdentifier) {
      if (identityRecord && identityRecord.publicKey) {
        return constantTimeEqual(identityRecord.publicKey, publicKey);
      }
      window.log.warn(
        'isTrustedIdentity: No local record for our own identifier. Returning true.'
      );
      return true;
    }

    switch (direction) {
      case Direction.Sending:
        return this.isTrustedForSending(publicKey, identityRecord);
      case Direction.Receiving:
        return true;
      default:
        throw new Error(`isTrustedIdentity: Unknown direction: ${direction}`);
    }
  }

  isTrustedForSending(
    publicKey: ArrayBuffer,
    identityRecord?: IdentityKeyType
  ): boolean {
    if (!identityRecord) {
      window.log.info(
        'isTrustedForSending: No previous record, returning true...'
      );
      return true;
    }

    const existing = identityRecord.publicKey;

    if (!existing) {
      window.log.info('isTrustedForSending: Nothing here, returning true...');
      return true;
    }
    if (!constantTimeEqual(existing, publicKey)) {
      window.log.info("isTrustedForSending: Identity keys don't match...");
      return false;
    }
    if (identityRecord.verified === VerifiedStatus.UNVERIFIED) {
      window.log.error('isTrustedIdentity: Needs unverified approval!');
      return false;
    }
    if (this.isNonBlockingApprovalRequired(identityRecord)) {
      window.log.error('isTrustedForSending: Needs non-blocking approval!');
      return false;
    }

    return true;
  }

  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    if (identifier === null || identifier === undefined) {
      throw new Error('loadIdentityKey: identifier was undefined/null');
    }
    const id = window.textsecure.utils.unencodeNumber(identifier)[0];
    const identityRecord = this.getIdentityRecord(id);

    if (identityRecord) {
      return identityRecord.publicKey;
    }

    return undefined;
  }

  private async _saveIdentityKey(data: IdentityKeyType): Promise<void> {
    if (!this.identityKeys) {
      throw new Error('_saveIdentityKey: this.identityKeys not yet cached!');
    }

    const { id } = data;

    await window.Signal.Data.createOrUpdateIdentityKey(data);
    this.identityKeys.set(id, {
      hydrated: false,
      fromDB: data,
    });
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    nonblockingApproval = false
  ): Promise<boolean> {
    if (!this.identityKeys) {
      throw new Error('saveIdentity: this.identityKeys not yet cached!');
    }

    if (encodedAddress === null || encodedAddress === undefined) {
      throw new Error('saveIdentity: encodedAddress was undefined/null');
    }
    if (!(publicKey instanceof ArrayBuffer)) {
      // eslint-disable-next-line no-param-reassign
      publicKey = fromEncodedBinaryToArrayBuffer(publicKey);
    }
    if (typeof nonblockingApproval !== 'boolean') {
      // eslint-disable-next-line no-param-reassign
      nonblockingApproval = false;
    }

    const identifier = window.textsecure.utils.unencodeNumber(
      encodedAddress
    )[0];
    const identityRecord = this.getIdentityRecord(identifier);
    const id = window.ConversationController.getOrCreate(
      identifier,
      'private'
    ).get('id');

    if (!identityRecord || !identityRecord.publicKey) {
      // Lookup failed, or the current key was removed, so save this one.
      window.log.info('saveIdentity: Saving new identity...');
      await this._saveIdentityKey({
        id,
        publicKey,
        firstUse: true,
        timestamp: Date.now(),
        verified: VerifiedStatus.DEFAULT,
        nonblockingApproval,
      });

      return false;
    }

    const oldpublicKey = identityRecord.publicKey;
    if (!constantTimeEqual(oldpublicKey, publicKey)) {
      window.log.info('saveIdentity: Replacing existing identity...');
      const previousStatus = identityRecord.verified;
      let verifiedStatus;
      if (
        previousStatus === VerifiedStatus.VERIFIED ||
        previousStatus === VerifiedStatus.UNVERIFIED
      ) {
        verifiedStatus = VerifiedStatus.UNVERIFIED;
      } else {
        verifiedStatus = VerifiedStatus.DEFAULT;
      }

      await this._saveIdentityKey({
        id,
        publicKey,
        firstUse: false,
        timestamp: Date.now(),
        verified: verifiedStatus,
        nonblockingApproval,
      });

      try {
        this.trigger('keychange', identifier);
      } catch (error) {
        window.log.error(
          'saveIdentity: error triggering keychange:',
          error && error.stack ? error.stack : error
        );
      }
      await this.archiveSiblingSessions(encodedAddress);

      return true;
    }
    if (this.isNonBlockingApprovalRequired(identityRecord)) {
      window.log.info('saveIdentity: Setting approval status...');

      identityRecord.nonblockingApproval = nonblockingApproval;
      await this._saveIdentityKey(identityRecord);

      return false;
    }

    return false;
  }

  isNonBlockingApprovalRequired(identityRecord: IdentityKeyType): boolean {
    return (
      !identityRecord.firstUse &&
      isMoreRecentThan(identityRecord.timestamp, TIMESTAMP_THRESHOLD) &&
      !identityRecord.nonblockingApproval
    );
  }

  async saveIdentityWithAttributes(
    encodedAddress: string,
    attributes: Partial<IdentityKeyType>
  ): Promise<void> {
    if (encodedAddress === null || encodedAddress === undefined) {
      throw new Error(
        'saveIdentityWithAttributes: encodedAddress was undefined/null'
      );
    }

    const identifier = window.textsecure.utils.unencodeNumber(
      encodedAddress
    )[0];
    const identityRecord = this.getIdentityRecord(identifier);
    const conv = window.ConversationController.getOrCreate(
      identifier,
      'private'
    );
    const id = conv.get('id');

    const updates: Partial<IdentityKeyType> = {
      ...identityRecord,
      ...attributes,
      id,
    };

    if (validateIdentityKey(updates)) {
      await this._saveIdentityKey(updates);
    }
  }

  async setApproval(
    encodedAddress: string,
    nonblockingApproval: boolean
  ): Promise<void> {
    if (encodedAddress === null || encodedAddress === undefined) {
      throw new Error('setApproval: encodedAddress was undefined/null');
    }
    if (typeof nonblockingApproval !== 'boolean') {
      throw new Error('setApproval: Invalid approval status');
    }

    const identifier = window.textsecure.utils.unencodeNumber(
      encodedAddress
    )[0];
    const identityRecord = this.getIdentityRecord(identifier);

    if (!identityRecord) {
      throw new Error(`setApproval: No identity record for ${identifier}`);
    }

    identityRecord.nonblockingApproval = nonblockingApproval;
    await this._saveIdentityKey(identityRecord);
  }

  async setVerified(
    encodedAddress: string,
    verifiedStatus: number,
    publicKey?: ArrayBuffer
  ): Promise<void> {
    if (encodedAddress === null || encodedAddress === undefined) {
      throw new Error('setVerified: encodedAddress was undefined/null');
    }
    if (!validateVerifiedStatus(verifiedStatus)) {
      throw new Error('setVerified: Invalid verified status');
    }
    if (arguments.length > 2 && !(publicKey instanceof ArrayBuffer)) {
      throw new Error('setVerified: Invalid public key');
    }

    const identityRecord = this.getIdentityRecord(encodedAddress);

    if (!identityRecord) {
      throw new Error(`setVerified: No identity record for ${encodedAddress}`);
    }

    if (!publicKey || constantTimeEqual(identityRecord.publicKey, publicKey)) {
      identityRecord.verified = verifiedStatus;

      if (validateIdentityKey(identityRecord)) {
        await this._saveIdentityKey(identityRecord);
      }
    } else {
      window.log.info(
        'setVerified: No identity record for specified publicKey'
      );
    }
  }

  async getVerified(identifier: string): Promise<number> {
    if (identifier === null || identifier === undefined) {
      throw new Error('getVerified: identifier was undefined/null');
    }

    const identityRecord = this.getIdentityRecord(identifier);
    if (!identityRecord) {
      throw new Error(`getVerified: No identity record for ${identifier}`);
    }

    const verifiedStatus = identityRecord.verified;
    if (validateVerifiedStatus(verifiedStatus)) {
      return verifiedStatus;
    }

    return VerifiedStatus.DEFAULT;
  }

  // Resolves to true if a new identity key was saved
  processContactSyncVerificationState(
    identifier: string,
    verifiedStatus: number,
    publicKey: ArrayBuffer
  ): Promise<boolean> {
    if (verifiedStatus === VerifiedStatus.UNVERIFIED) {
      return this.processUnverifiedMessage(
        identifier,
        verifiedStatus,
        publicKey
      );
    }
    return this.processVerifiedMessage(identifier, verifiedStatus, publicKey);
  }

  // This function encapsulates the non-Java behavior, since the mobile apps don't
  //   currently receive contact syncs and therefore will see a verify sync with
  //   UNVERIFIED status
  async processUnverifiedMessage(
    identifier: string,
    verifiedStatus: number,
    publicKey?: ArrayBuffer
  ): Promise<boolean> {
    if (identifier === null || identifier === undefined) {
      throw new Error(
        'processUnverifiedMessage: identifier was undefined/null'
      );
    }
    if (publicKey !== undefined && !(publicKey instanceof ArrayBuffer)) {
      throw new Error('processUnverifiedMessage: Invalid public key');
    }

    const identityRecord = this.getIdentityRecord(identifier);

    let isEqual = false;

    if (identityRecord && publicKey) {
      isEqual = constantTimeEqual(publicKey, identityRecord.publicKey);
    }

    if (
      identityRecord &&
      isEqual &&
      identityRecord.verified !== VerifiedStatus.UNVERIFIED
    ) {
      await this.setVerified(identifier, verifiedStatus, publicKey);
      return false;
    }

    if (!identityRecord || !isEqual) {
      await this.saveIdentityWithAttributes(identifier, {
        publicKey,
        verified: verifiedStatus,
        firstUse: false,
        timestamp: Date.now(),
        nonblockingApproval: true,
      });

      if (identityRecord && !isEqual) {
        try {
          this.trigger('keychange', identifier);
        } catch (error) {
          window.log.error(
            'processUnverifiedMessage: error triggering keychange:',
            error && error.stack ? error.stack : error
          );
        }

        await this.archiveAllSessions(identifier);

        return true;
      }
    }

    // The situation which could get us here is:
    //   1. had a previous key
    //   2. new key is the same
    //   3. desired new status is same as what we had before
    return false;
  }

  // This matches the Java method as of
  //   https://github.com/signalapp/Signal-Android/blob/d0bb68e1378f689e4d10ac6a46014164992ca4e4/src/org/thoughtcrime/securesms/util/IdentityUtil.java#L188
  async processVerifiedMessage(
    identifier: string,
    verifiedStatus: number,
    publicKey?: ArrayBuffer
  ): Promise<boolean> {
    if (identifier === null || identifier === undefined) {
      throw new Error('processVerifiedMessage: identifier was undefined/null');
    }
    if (!validateVerifiedStatus(verifiedStatus)) {
      throw new Error('processVerifiedMessage: Invalid verified status');
    }
    if (publicKey !== undefined && !(publicKey instanceof ArrayBuffer)) {
      throw new Error('processVerifiedMessage: Invalid public key');
    }

    const identityRecord = this.getIdentityRecord(identifier);

    let isEqual = false;

    if (identityRecord && publicKey) {
      isEqual = constantTimeEqual(publicKey, identityRecord.publicKey);
    }

    if (!identityRecord && verifiedStatus === VerifiedStatus.DEFAULT) {
      window.log.info(
        'processVerifiedMessage: No existing record for default status'
      );
      return false;
    }

    if (
      identityRecord &&
      isEqual &&
      identityRecord.verified !== VerifiedStatus.DEFAULT &&
      verifiedStatus === VerifiedStatus.DEFAULT
    ) {
      await this.setVerified(identifier, verifiedStatus, publicKey);
      return false;
    }

    if (
      verifiedStatus === VerifiedStatus.VERIFIED &&
      (!identityRecord ||
        (identityRecord && !isEqual) ||
        (identityRecord && identityRecord.verified !== VerifiedStatus.VERIFIED))
    ) {
      await this.saveIdentityWithAttributes(identifier, {
        publicKey,
        verified: verifiedStatus,
        firstUse: false,
        timestamp: Date.now(),
        nonblockingApproval: true,
      });

      if (identityRecord && !isEqual) {
        try {
          this.trigger('keychange', identifier);
        } catch (error) {
          window.log.error(
            'processVerifiedMessage error triggering keychange:',
            error && error.stack ? error.stack : error
          );
        }

        await this.archiveAllSessions(identifier);

        // true signifies that we overwrote a previous key with a new one
        return true;
      }
    }

    // We get here if we got a new key and the status is DEFAULT. If the
    //   message is out of date, we don't want to lose whatever more-secure
    //   state we had before.
    return false;
  }

  isUntrusted(identifier: string): boolean {
    if (identifier === null || identifier === undefined) {
      throw new Error('isUntrusted: identifier was undefined/null');
    }

    const identityRecord = this.getIdentityRecord(identifier);
    if (!identityRecord) {
      throw new Error(`isUntrusted: No identity record for ${identifier}`);
    }

    if (
      isMoreRecentThan(identityRecord.timestamp, TIMESTAMP_THRESHOLD) &&
      !identityRecord.nonblockingApproval &&
      !identityRecord.firstUse
    ) {
      return true;
    }

    return false;
  }

  async removeIdentityKey(identifier: string): Promise<void> {
    if (!this.identityKeys) {
      throw new Error('removeIdentityKey: this.identityKeys not yet cached!');
    }

    const id = window.ConversationController.getConversationId(identifier);
    if (id) {
      this.identityKeys.delete(id);
      await window.Signal.Data.removeIdentityKeyById(id);
      await this.removeAllSessions(id);
    }
  }

  // Not yet processed messages - for resiliency
  getUnprocessedCount(): Promise<number> {
    return this.sessionTransaction('getUnprocessedCount', async () => {
      this._checkNoPendingUnprocessed();
      return window.Signal.Data.getUnprocessedCount();
    });
  }

  getAllUnprocessed(): Promise<Array<UnprocessedType>> {
    return this.sessionTransaction('getAllUnprocessed', async () => {
      this._checkNoPendingUnprocessed();
      return window.Signal.Data.getAllUnprocessed();
    });
  }

  getUnprocessedById(id: string): Promise<UnprocessedType | undefined> {
    return this.sessionTransaction('getUnprocessedById', async () => {
      this._checkNoPendingUnprocessed();
      return window.Signal.Data.getUnprocessedById(id);
    });
  }

  addUnprocessed(
    data: UnprocessedType,
    { lock }: SessionTransactionOptions = {}
  ): Promise<void> {
    return this.sessionTransaction(
      'addUnprocessed',
      async () => {
        this.pendingUnprocessed.set(data.id, data);
      },
      lock
    );
  }

  addMultipleUnprocessed(
    array: Array<UnprocessedType>,
    { lock }: SessionTransactionOptions = {}
  ): Promise<void> {
    return this.sessionTransaction(
      'addMultipleUnprocessed',
      async () => {
        for (const elem of array) {
          this.pendingUnprocessed.set(elem.id, elem);
        }
      },
      lock
    );
  }

  updateUnprocessedAttempts(id: string, attempts: number): Promise<void> {
    return this.sessionTransaction('updateUnprocessedAttempts', async () => {
      this._checkNoPendingUnprocessed();
      await window.Signal.Data.updateUnprocessedAttempts(id, attempts);
    });
  }

  updateUnprocessedWithData(
    id: string,
    data: UnprocessedUpdateType
  ): Promise<void> {
    return this.sessionTransaction('updateUnprocessedWithData', async () => {
      this._checkNoPendingUnprocessed();
      await window.Signal.Data.updateUnprocessedWithData(id, data);
    });
  }

  updateUnprocessedsWithData(
    items: Array<{ id: string; data: UnprocessedUpdateType }>
  ): Promise<void> {
    return this.sessionTransaction('updateUnprocessedsWithData', async () => {
      this._checkNoPendingUnprocessed();
      await window.Signal.Data.updateUnprocessedsWithData(items);
    });
  }

  removeUnprocessed(idOrArray: string | Array<string>): Promise<void> {
    return this.sessionTransaction('removeUnprocessed', async () => {
      this._checkNoPendingUnprocessed();
      await window.Signal.Data.removeUnprocessed(idOrArray);
    });
  }

  removeAllUnprocessed(): Promise<void> {
    return this.sessionTransaction('removeAllUnprocessed', async () => {
      this._checkNoPendingUnprocessed();
      await window.Signal.Data.removeAllUnprocessed();
    });
  }

  async removeAllData(): Promise<void> {
    await window.Signal.Data.removeAll();
    await this.hydrateCaches();

    window.storage.reset();
    await window.storage.fetch();

    window.ConversationController.reset();
    await window.ConversationController.load();
  }

  async removeAllConfiguration(): Promise<void> {
    await window.Signal.Data.removeAllConfiguration();
    await this.hydrateCaches();

    window.storage.reset();
    await window.storage.fetch();
  }

  private _getAllSessions(): Array<SessionCacheEntry> {
    const union = new Map<string, SessionCacheEntry>();

    this.sessions?.forEach((value, key) => {
      union.set(key, value);
    });
    this.pendingSessions.forEach((value, key) => {
      union.set(key, value);
    });

    return Array.from(union.values());
  }

  private _checkNoPendingUnprocessed(): void {
    assert(
      !this.sessionLock || this.sessionLock === GLOBAL_LOCK,
      "Can't use this function with a global lock"
    );
    assert(
      this.pendingUnprocessed.size === 0,
      'Missing support for pending unprocessed'
    );
  }
}

window.SignalProtocolStore = SignalProtocolStore;
