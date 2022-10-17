// Copyright 2021-2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ThunkAction, ThunkDispatch } from 'redux-thunk';
import { isEqual, pick } from 'lodash';
import type { AttachmentType } from '../../types/Attachment';
import type { BodyRangeType } from '../../types/Util';
import type { ConversationModel } from '../../models/conversations';
import type { MessageAttributesType } from '../../model-types.d';
import type {
  MessageChangedActionType,
  MessageDeletedActionType,
  MessagesAddedActionType,
} from './conversations';
import type { NoopActionType } from './noop';
import type { StateType as RootStateType } from '../reducer';
import type { StoryViewTargetType, StoryViewType } from '../../types/Stories';
import type { SyncType } from '../../jobs/helpers/syncHelpers';
import type { UUIDStringType } from '../../types/UUID';
import * as log from '../../logging/log';
import dataInterface from '../../sql/Client';
import { ReadStatus } from '../../messages/MessageReadStatus';
import { SafetyNumberChangeSource } from '../../components/SafetyNumberChangeDialog';
import { StoryViewDirectionType, StoryViewModeType } from '../../types/Stories';
import { ToastReactionFailed } from '../../components/ToastReactionFailed';
import { assertDev } from '../../util/assert';
import { blockSendUntilConversationsAreVerified } from '../../util/blockSendUntilConversationsAreVerified';
import { deleteStoryForEveryone as doDeleteStoryForEveryone } from '../../util/deleteStoryForEveryone';
import { enqueueReactionForSend } from '../../reactions/enqueueReactionForSend';
import { getMessageById } from '../../messages/getMessageById';
import { markViewed } from '../../services/MessageUpdater';
import { queueAttachmentDownloads } from '../../util/queueAttachmentDownloads';
import { replaceIndex } from '../../util/replaceIndex';
import { showToast } from '../../util/showToast';
import {
  hasFailed,
  hasNotResolved,
  isDownloaded,
  isDownloading,
} from '../../types/Attachment';
import {
  getConversationSelector,
  getHideStoryConversationIds,
} from '../selectors/conversations';
import { getStories } from '../selectors/stories';
import { getStoryDataFromMessageAttributes } from '../../services/storyLoader';
import { isGroup } from '../../util/whatTypeOfConversation';
import { isNotNil } from '../../util/isNotNil';
import { isStory } from '../../messages/helpers';
import { sendStoryMessage as doSendStoryMessage } from '../../util/sendStoryMessage';
import { useBoundActions } from '../../hooks/useBoundActions';
import { verifyStoryListMembers as doVerifyStoryListMembers } from '../../util/verifyStoryListMembers';
import { viewSyncJobQueue } from '../../jobs/viewSyncJobQueue';
import { viewedReceiptsJobQueue } from '../../jobs/viewedReceiptsJobQueue';

export type StoryDataType = {
  attachment?: AttachmentType;
  messageId: string;
  startedDownload?: boolean;
} & Pick<
  MessageAttributesType,
  | 'canReplyToStory'
  | 'conversationId'
  | 'deletedForEveryone'
  | 'reactions'
  | 'readAt'
  | 'readStatus'
  | 'sendStateByConversationId'
  | 'source'
  | 'sourceUuid'
  | 'sourceDevice'
  | 'storyDistributionListId'
  | 'timestamp'
  | 'type'
> & {
    // don't want the fields to be optional as in MessageAttributesType
    expireTimer: number | undefined;
    expirationStartTimestamp: number | undefined;
  };

export type SelectedStoryDataType = {
  currentIndex: number;
  messageId: string;
  numStories: number;
  storyViewMode: StoryViewModeType;
  unviewedStoryConversationIdsSorted: Array<string>;
  viewTarget?: StoryViewTargetType;
};

// State

export type StoriesStateType = {
  readonly lastOpenedAtTimestamp: number | undefined;
  readonly openedAtTimestamp: number | undefined;
  readonly replyState?: {
    messageId: string;
    replies: Array<MessageAttributesType>;
  };
  readonly selectedStoryData?: SelectedStoryDataType;
  readonly sendStoryModalData?: {
    untrustedUuids: Array<string>;
    verifiedUuids: Array<string>;
  };
  readonly stories: Array<StoryDataType>;
};

// Actions

const DOE_STORY = 'stories/DOE';
const LIST_MEMBERS_VERIFIED = 'stories/LIST_MEMBERS_VERIFIED';
const LOAD_STORY_REPLIES = 'stories/LOAD_STORY_REPLIES';
const MARK_STORY_READ = 'stories/MARK_STORY_READ';
const QUEUE_STORY_DOWNLOAD = 'stories/QUEUE_STORY_DOWNLOAD';
const REPLY_TO_STORY = 'stories/REPLY_TO_STORY';
export const RESOLVE_ATTACHMENT_URL = 'stories/RESOLVE_ATTACHMENT_URL';
const SEND_STORY_MODAL_OPEN_STATE_CHANGED =
  'stories/SEND_STORY_MODAL_OPEN_STATE_CHANGED';
const STORY_CHANGED = 'stories/STORY_CHANGED';
const TOGGLE_VIEW = 'stories/TOGGLE_VIEW';
const VIEW_STORY = 'stories/VIEW_STORY';

type DOEStoryActionType = {
  type: typeof DOE_STORY;
  payload: string;
};

type ListMembersVerified = {
  type: typeof LIST_MEMBERS_VERIFIED;
  payload: {
    untrustedUuids: Array<string>;
    verifiedUuids: Array<string>;
  };
};

type LoadStoryRepliesActionType = {
  type: typeof LOAD_STORY_REPLIES;
  payload: {
    messageId: string;
    replies: Array<MessageAttributesType>;
  };
};

type MarkStoryReadActionType = {
  type: typeof MARK_STORY_READ;
  payload: {
    messageId: string;
    readAt: number;
  };
};

type QueueStoryDownloadActionType = {
  type: typeof QUEUE_STORY_DOWNLOAD;
  payload: string;
};

type ReplyToStoryActionType = {
  type: typeof REPLY_TO_STORY;
  payload: MessageAttributesType;
};

type ResolveAttachmentUrlActionType = {
  type: typeof RESOLVE_ATTACHMENT_URL;
  payload: {
    messageId: string;
    attachmentUrl: string;
  };
};

type SendStoryModalOpenStateChanged = {
  type: typeof SEND_STORY_MODAL_OPEN_STATE_CHANGED;
  payload: number | undefined;
};

type StoryChangedActionType = {
  type: typeof STORY_CHANGED;
  payload: StoryDataType;
};

type ToggleViewActionType = {
  type: typeof TOGGLE_VIEW;
};

type ViewStoryActionType = {
  type: typeof VIEW_STORY;
  payload: SelectedStoryDataType | undefined;
};

export type StoriesActionType =
  | DOEStoryActionType
  | ListMembersVerified
  | LoadStoryRepliesActionType
  | MarkStoryReadActionType
  | MessageChangedActionType
  | MessageDeletedActionType
  | MessagesAddedActionType
  | QueueStoryDownloadActionType
  | ReplyToStoryActionType
  | ResolveAttachmentUrlActionType
  | SendStoryModalOpenStateChanged
  | StoryChangedActionType
  | ToggleViewActionType
  | ViewStoryActionType;

// Action Creators

function deleteStoryForEveryone(
  story: StoryViewType
): ThunkAction<void, RootStateType, unknown, DOEStoryActionType> {
  return async (dispatch, getState) => {
    if (!story.sendState) {
      return;
    }

    const { stories } = getState().stories;
    const storyData = stories.find(item => item.messageId === story.messageId);
    if (!storyData) {
      log.warn('deleteStoryForEveryone: Could not find story in redux data');
      return;
    }
    await doDeleteStoryForEveryone(stories, storyData);

    dispatch({
      type: DOE_STORY,
      payload: story.messageId,
    });
  };
}

function loadStoryReplies(
  conversationId: string,
  messageId: string
): ThunkAction<void, RootStateType, unknown, LoadStoryRepliesActionType> {
  return async (dispatch, getState) => {
    const conversation = getConversationSelector(getState())(conversationId);
    const replies = await dataInterface.getOlderMessagesByConversation(
      conversationId,
      {
        limit: 9000,
        storyId: messageId,
        includeStoryReplies: !isGroup(conversation),
      }
    );

    dispatch({
      type: LOAD_STORY_REPLIES,
      payload: {
        messageId,
        replies,
      },
    });
  };
}

function markStoryRead(
  messageId: string
): ThunkAction<void, RootStateType, unknown, MarkStoryReadActionType> {
  return async (dispatch, getState) => {
    const { stories } = getState().stories;

    const matchingStory = stories.find(story => story.messageId === messageId);

    if (!matchingStory) {
      log.warn(`markStoryRead: no matching story found: ${messageId}`);
      return;
    }

    if (
      !isDownloaded(matchingStory.attachment) &&
      !hasFailed(matchingStory.attachment)
    ) {
      log.warn(
        `markStoryRead: not downloaded: ${messageId} ${
          matchingStory.attachment?.error
            ? `error: ${matchingStory.attachment?.error}`
            : ''
        }`
      );
      return;
    }

    if (matchingStory.readStatus !== ReadStatus.Unread) {
      log.warn(
        `markStoryRead: not unread, ${messageId} read status: ${matchingStory.readStatus}`
      );
      return;
    }

    const message = await getMessageById(messageId);

    if (!message) {
      log.warn(`markStoryRead: no message found ${messageId}`);
      return;
    }

    const storyReadDate = Date.now();

    message.set(markViewed(message.attributes, storyReadDate));

    const viewedReceipt = {
      messageId,
      senderE164: message.attributes.source,
      senderUuid: message.attributes.sourceUuid,
      timestamp: message.attributes.sent_at,
      isDirectConversation: false,
    };
    const viewSyncs: Array<SyncType> = [viewedReceipt];

    if (!window.ConversationController.areWePrimaryDevice()) {
      viewSyncJobQueue.add({ viewSyncs });
    }

    viewedReceiptsJobQueue.add({ viewedReceipt });

    await dataInterface.addNewStoryRead({
      authorId: message.attributes.sourceUuid,
      conversationId: message.attributes.conversationId,
      storyId: messageId,
      storyReadDate,
    });

    dispatch({
      type: MARK_STORY_READ,
      payload: {
        messageId,
        readAt: storyReadDate,
      },
    });
  };
}

function queueStoryDownload(
  storyId: string
): ThunkAction<
  void,
  RootStateType,
  unknown,
  NoopActionType | QueueStoryDownloadActionType | ResolveAttachmentUrlActionType
> {
  return async (dispatch, getState) => {
    const { stories } = getState().stories;
    const story = stories.find(item => item.messageId === storyId);

    if (!story) {
      return;
    }

    const { attachment } = story;

    if (!attachment) {
      log.warn('queueStoryDownload: No attachment found for story', {
        storyId,
      });
      return;
    }

    if (hasFailed(attachment)) {
      return;
    }

    if (isDownloaded(attachment)) {
      if (!attachment.path) {
        return;
      }

      // This function also resolves the attachment's URL in case we've already
      // downloaded the attachment but haven't pointed its path to an absolute
      // location on disk.
      if (hasNotResolved(attachment)) {
        dispatch({
          type: RESOLVE_ATTACHMENT_URL,
          payload: {
            messageId: storyId,
            attachmentUrl: window.Signal.Migrations.getAbsoluteAttachmentPath(
              attachment.path
            ),
          },
        });
      }

      return;
    }

    // isDownloading checks for the downloadJobId which is set by
    // queueAttachmentDownloads but we optimistically set story.startedDownload
    // in redux to prevent race conditions from queuing up multiple attachment
    // downloads before the attachment save takes place.
    if (isDownloading(attachment) || story.startedDownload) {
      return;
    }

    const message = await getMessageById(storyId);

    if (message) {
      // We want to ensure that we re-hydrate the story reply context with the
      // completed attachment download.
      message.set({ storyReplyContext: undefined });

      dispatch({
        type: QUEUE_STORY_DOWNLOAD,
        payload: storyId,
      });

      await queueAttachmentDownloads(message.attributes);
      return;
    }

    dispatch({
      type: 'NOOP',
      payload: null,
    });
  };
}

function reactToStory(
  nextReaction: string,
  messageId: string
): ThunkAction<void, RootStateType, unknown, NoopActionType> {
  return async dispatch => {
    try {
      await enqueueReactionForSend({
        messageId,
        emoji: nextReaction,
        remove: false,
      });
    } catch (error) {
      log.error('Error enqueuing reaction', error, messageId, nextReaction);
      showToast(ToastReactionFailed);
    }

    dispatch({
      type: 'NOOP',
      payload: null,
    });
  };
}

function replyToStory(
  conversationId: string,
  messageBody: string,
  mentions: Array<BodyRangeType>,
  timestamp: number,
  story: StoryViewType
): ThunkAction<void, RootStateType, unknown, ReplyToStoryActionType> {
  return async dispatch => {
    const conversation = window.ConversationController.get(conversationId);

    if (!conversation) {
      log.error('replyToStory: conversation does not exist', conversationId);
      return;
    }

    const messageAttributes = await conversation.enqueueMessageForSend(
      {
        body: messageBody,
        attachments: [],
        mentions,
      },
      {
        storyId: story.messageId,
        timestamp,
      }
    );

    if (messageAttributes) {
      dispatch({
        type: REPLY_TO_STORY,
        payload: messageAttributes,
      });
    }
  };
}

function sendStoryMessage(
  listIds: Array<UUIDStringType>,
  conversationIds: Array<string>,
  attachment: AttachmentType
): ThunkAction<void, RootStateType, unknown, SendStoryModalOpenStateChanged> {
  return async (dispatch, getState) => {
    const { stories } = getState();
    const { openedAtTimestamp, sendStoryModalData } = stories;
    assertDev(
      openedAtTimestamp,
      'sendStoryMessage: openedAtTimestamp is undefined, cannot send'
    );
    assertDev(
      sendStoryModalData,
      'sendStoryMessage: sendStoryModalData is not defined, cannot send'
    );

    dispatch({
      type: SEND_STORY_MODAL_OPEN_STATE_CHANGED,
      payload: undefined,
    });

    if (sendStoryModalData.untrustedUuids.length) {
      log.info('sendStoryMessage: SN changed for some conversations');

      const conversationsNeedingVerification: Array<ConversationModel> =
        sendStoryModalData.untrustedUuids
          .map(uuid => window.ConversationController.get(uuid))
          .filter(isNotNil);

      if (!conversationsNeedingVerification.length) {
        log.warn(
          'sendStoryMessage: Could not retrieve conversations for untrusted uuids'
        );
        return;
      }

      const result = await blockSendUntilConversationsAreVerified(
        conversationsNeedingVerification,
        SafetyNumberChangeSource.Story,
        Date.now() - openedAtTimestamp
      );

      if (!result) {
        log.info('sendStoryMessage: did not send');
        return;
      }
    }

    await doSendStoryMessage(listIds, conversationIds, attachment);
  };
}

function storyChanged(story: StoryDataType): StoryChangedActionType {
  return {
    type: STORY_CHANGED,
    payload: story,
  };
}

function sendStoryModalOpenStateChanged(
  value: boolean
): ThunkAction<void, RootStateType, unknown, SendStoryModalOpenStateChanged> {
  return (dispatch, getState) => {
    const { stories } = getState();

    if (!stories.sendStoryModalData && value) {
      dispatch({
        type: SEND_STORY_MODAL_OPEN_STATE_CHANGED,
        payload: Date.now(),
      });
    }

    if (stories.sendStoryModalData && !value) {
      dispatch({
        type: SEND_STORY_MODAL_OPEN_STATE_CHANGED,
        payload: undefined,
      });
    }
  };
}

function toggleStoriesView(): ToggleViewActionType {
  return {
    type: TOGGLE_VIEW,
  };
}

function verifyStoryListMembers(
  memberUuids: Array<string>
): ThunkAction<void, RootStateType, unknown, ListMembersVerified> {
  return async (dispatch, getState) => {
    const { stories } = getState();
    const { sendStoryModalData } = stories;

    if (!sendStoryModalData) {
      return;
    }

    const alreadyVerifiedUuids = new Set([...sendStoryModalData.verifiedUuids]);

    const uuidsNeedingVerification = memberUuids.filter(
      uuid => !alreadyVerifiedUuids.has(uuid)
    );

    if (!uuidsNeedingVerification.length) {
      return;
    }

    const { untrustedUuids, verifiedUuids } = await doVerifyStoryListMembers(
      uuidsNeedingVerification
    );

    dispatch({
      type: LIST_MEMBERS_VERIFIED,
      payload: {
        untrustedUuids: Array.from(untrustedUuids),
        verifiedUuids: Array.from(verifiedUuids),
      },
    });
  };
}

const getSelectedStoryDataForDistributionListId = (
  getState: () => RootStateType,
  distributionListId: string | undefined,
  selectedStoryId?: string
): {
  currentIndex: number;
  numStories: number;
  storiesByConversationId: Array<StoryDataType>;
} => {
  const state = getState();
  const { stories } = state.stories;

  const storiesByDistributionList = stories.filter(
    item =>
      item.storyDistributionListId === distributionListId &&
      !item.deletedForEveryone
  );

  const numStories = storiesByDistributionList.length;
  const currentIndex = selectedStoryId
    ? storiesByDistributionList.findIndex(
        item => item.messageId === selectedStoryId
      )
    : 0;

  return {
    currentIndex,
    numStories,
    storiesByConversationId: [],
  };
};

const getSelectedStoryDataForConversationId = (
  dispatch: ThunkDispatch<
    RootStateType,
    unknown,
    NoopActionType | ResolveAttachmentUrlActionType
  >,
  getState: () => RootStateType,
  conversationId: string,
  selectedStoryId?: string
): {
  currentIndex: number;
  hasUnread: boolean;
  numStories: number;
  storiesByConversationId: Array<StoryDataType>;
} => {
  const state = getState();
  const { stories } = state.stories;

  const storiesByConversationId = stories.filter(
    item => item.conversationId === conversationId && !item.deletedForEveryone
  );

  // Find the index of the storyId provided, or if none provided then find the
  // oldest unviewed story from the user. If all stories are read then we can
  // start at the first story.
  let currentIndex: number | undefined;
  let hasUnread = false;
  storiesByConversationId.forEach((item, index) => {
    if (selectedStoryId && item.messageId === selectedStoryId) {
      currentIndex = index;
    }

    if (
      !selectedStoryId &&
      currentIndex === undefined &&
      item.readStatus === ReadStatus.Unread
    ) {
      hasUnread = true;
      currentIndex = index;
    }
  });

  const numStories = storiesByConversationId.length;

  // Queue all undownloaded stories once we're viewing someone's stories
  storiesByConversationId.forEach(item => {
    if (isDownloaded(item.attachment) || isDownloading(item.attachment)) {
      return;
    }

    queueStoryDownload(item.messageId)(dispatch, getState, null);
  });

  return {
    currentIndex: currentIndex ?? 0,
    hasUnread,
    numStories,
    storiesByConversationId,
  };
};

export type ViewUserStoriesActionCreatorType = (opts: {
  conversationId: string;
  storyViewMode?: StoryViewModeType;
  viewTarget?: StoryViewTargetType;
}) => unknown;

const viewUserStories: ViewUserStoriesActionCreatorType = ({
  conversationId,
  storyViewMode,
  viewTarget,
}): ThunkAction<void, RootStateType, unknown, ViewStoryActionType> => {
  return (dispatch, getState) => {
    const { currentIndex, hasUnread, numStories, storiesByConversationId } =
      getSelectedStoryDataForConversationId(dispatch, getState, conversationId);

    const story = storiesByConversationId[currentIndex];
    const state = getState();

    const hiddenConversationIds = new Set(getHideStoryConversationIds(state));

    let inferredStoryViewMode: StoryViewModeType;
    if (storyViewMode) {
      inferredStoryViewMode = storyViewMode;
    } else if (hiddenConversationIds.has(conversationId)) {
      inferredStoryViewMode = StoryViewModeType.Hidden;
    } else if (hasUnread) {
      inferredStoryViewMode = StoryViewModeType.Unread;
    } else {
      inferredStoryViewMode = StoryViewModeType.All;
    }

    let unviewedStoryConversationIdsSorted: Array<string> = [];
    if (
      inferredStoryViewMode === StoryViewModeType.Unread ||
      inferredStoryViewMode === StoryViewModeType.Hidden
    ) {
      const storiesSelectorState = getStories(state);
      const conversationStories =
        inferredStoryViewMode === StoryViewModeType.Hidden
          ? storiesSelectorState.hiddenStories
          : storiesSelectorState.stories;
      unviewedStoryConversationIdsSorted = conversationStories
        .filter(item => item.storyView.isUnread)
        .map(item => item.conversationId);
    }

    dispatch({
      type: VIEW_STORY,
      payload: {
        currentIndex,
        messageId: story.messageId,
        numStories,
        storyViewMode: inferredStoryViewMode,
        unviewedStoryConversationIdsSorted,
        viewTarget,
      },
    });
  };
};

type ViewStoryOptionsType =
  | {
      closeViewer: true;
    }
  | {
      storyId: string;
      storyViewMode: StoryViewModeType;
      viewDirection?: StoryViewDirectionType;
      viewTarget?: StoryViewTargetType;
    };

export type ViewStoryActionCreatorType = (
  opts: ViewStoryOptionsType
) => unknown;

export type DispatchableViewStoryType = (
  opts: ViewStoryOptionsType
) => ThunkAction<void, RootStateType, unknown, ViewStoryActionType>;

const viewStory: ViewStoryActionCreatorType = (
  opts
): ThunkAction<void, RootStateType, unknown, ViewStoryActionType> => {
  return (dispatch, getState) => {
    if ('closeViewer' in opts) {
      dispatch({
        type: VIEW_STORY,
        payload: undefined,
      });
      return;
    }

    const { viewTarget, storyId, storyViewMode, viewDirection } = opts;

    const state = getState();
    const { selectedStoryData, stories } = state.stories;

    const unviewedStoryConversationIdsSorted =
      selectedStoryData?.unviewedStoryConversationIdsSorted || [];

    // Spec:
    // When opening the story viewer you should always be taken to the oldest
    //    un viewed story of the user you tapped on
    // If all stories from a user are viewed, opening the viewer should take
    //    you to their oldest story

    const story = stories.find(
      item => item.messageId === storyId && !item.deletedForEveryone
    );

    if (!story) {
      log.warn('stories.viewStory: No story found', storyId);
      dispatch({
        type: VIEW_STORY,
        payload: undefined,
      });
      return;
    }

    const { currentIndex, numStories, storiesByConversationId } =
      storyViewMode === StoryViewModeType.MyStories
        ? getSelectedStoryDataForDistributionListId(
            getState,
            story.storyDistributionListId,
            storyId
          )
        : getSelectedStoryDataForConversationId(
            dispatch,
            getState,
            story.conversationId,
            storyId
          );

    // Go directly to the storyId selected
    if (!viewDirection) {
      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex,
          messageId: storyId,
          numStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
          viewTarget,
        },
      });
      return;
    }

    // When paging through all sent stories
    // Note the order is reversed[1][2] here because we sort the stories by
    // recency in descending order but the story viewer plays them in
    // ascending order.
    if (storyViewMode === StoryViewModeType.MyStories) {
      const { myStories } = getStories(state);

      let currentStoryIndex = -1;
      const currentDistributionListIndex = myStories.findIndex(item => {
        for (let i = item.stories.length - 1; i >= 0; i -= 1) {
          const myStory = item.stories[i];
          if (myStory.messageId === storyId) {
            // [1] reversed
            currentStoryIndex = item.stories.length - 1 - i;
            return true;
          }
        }
        return false;
      });

      if (currentDistributionListIndex < 0 || currentStoryIndex < 0) {
        log.warn('stories.viewStory: No current story found for MyStories', {
          currentDistributionListIndex,
          currentStoryIndex,
          myStories: myStories.length,
        });
        dispatch({
          type: VIEW_STORY,
          payload: undefined,
        });
        return;
      }

      let nextSentStoryId: string | undefined;
      let nextSentStoryIndex = -1;
      let nextNumStories = numStories;

      // [2] reversed
      const currentStories = myStories[currentDistributionListIndex].stories
        .slice()
        .reverse();

      if (viewDirection === StoryViewDirectionType.Next) {
        if (currentStoryIndex < currentStories.length - 1) {
          nextSentStoryIndex = currentStoryIndex + 1;
          nextSentStoryId = currentStories[nextSentStoryIndex].messageId;
        } else if (currentDistributionListIndex < myStories.length - 1) {
          const nextSentStoryContainer =
            myStories[currentDistributionListIndex + 1];

          nextNumStories = nextSentStoryContainer.stories.length;
          nextSentStoryIndex = 0;
          nextSentStoryId =
            nextSentStoryContainer.stories[nextNumStories - 1].messageId;
        }
      }

      if (viewDirection === StoryViewDirectionType.Previous) {
        if (currentStoryIndex > 0) {
          nextSentStoryIndex = currentStoryIndex - 1;
          nextSentStoryId = currentStories[nextSentStoryIndex].messageId;
        } else if (currentDistributionListIndex > 0) {
          const nextSentStoryContainer =
            myStories[currentDistributionListIndex - 1];

          nextNumStories = nextSentStoryContainer.stories.length;
          nextSentStoryIndex = nextNumStories - 1;
          nextSentStoryId = nextSentStoryContainer.stories[0].messageId;
        }
      }

      if (!nextSentStoryId) {
        dispatch({
          type: VIEW_STORY,
          payload: undefined,
        });
        return;
      }

      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex: nextSentStoryIndex,
          messageId: nextSentStoryId,
          numStories: nextNumStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
        },
      });
      return;
    }

    // Next story within the same user's stories
    if (
      viewDirection === StoryViewDirectionType.Next &&
      currentIndex < numStories - 1
    ) {
      const nextIndex = currentIndex + 1;
      const nextStory = storiesByConversationId[nextIndex];

      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex: nextIndex,
          messageId: nextStory.messageId,
          numStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
        },
      });
      return;
    }

    // Prev story within the same user's stories
    if (viewDirection === StoryViewDirectionType.Previous && currentIndex > 0) {
      const nextIndex = currentIndex - 1;
      const nextStory = storiesByConversationId[nextIndex];

      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex: nextIndex,
          messageId: nextStory.messageId,
          numStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
        },
      });
      return;
    }

    // We were just viewing a single user's stories. Close the viewer.
    if (storyViewMode === StoryViewModeType.User) {
      dispatch({
        type: VIEW_STORY,
        payload: undefined,
      });
      return;
    }

    const storiesSelectorState = getStories(state);
    const conversationStories =
      storyViewMode === StoryViewModeType.Hidden
        ? storiesSelectorState.hiddenStories
        : storiesSelectorState.stories;
    const conversationStoryIndex = conversationStories.findIndex(
      item => item.conversationId === story.conversationId
    );

    // Are there any unviewed stories left? If so we should play the unviewed
    // stories first.
    if (storyViewMode === StoryViewModeType.Unread) {
      const frozenConversationStoryIndex =
        unviewedStoryConversationIdsSorted.findIndex(
          conversationId => conversationId === story.conversationId
        );

      let nextUnreadConversationId: string | undefined;
      if (viewDirection === StoryViewDirectionType.Previous) {
        nextUnreadConversationId =
          unviewedStoryConversationIdsSorted[frozenConversationStoryIndex - 1];
      } else if (viewDirection === StoryViewDirectionType.Next) {
        nextUnreadConversationId =
          unviewedStoryConversationIdsSorted[frozenConversationStoryIndex + 1];
      }

      if (nextUnreadConversationId) {
        const nextSelectedStoryData = getSelectedStoryDataForConversationId(
          dispatch,
          getState,
          nextUnreadConversationId
        );

        dispatch({
          type: VIEW_STORY,
          payload: {
            currentIndex: nextSelectedStoryData.currentIndex,
            messageId:
              nextSelectedStoryData.storiesByConversationId[
                nextSelectedStoryData.currentIndex
              ].messageId,
            numStories: nextSelectedStoryData.numStories,
            storyViewMode,
            unviewedStoryConversationIdsSorted,
          },
        });
        return;
      }

      // Close the viewer if we were viewing unviewed stories only and we did
      // not find any more unviewed.
      dispatch({
        type: VIEW_STORY,
        payload: undefined,
      });
      return;
    }

    if (conversationStoryIndex < 0) {
      log.warn('stories.viewStory: No stories found for conversation', {
        storiesLength: conversationStories.length,
      });
      dispatch({
        type: VIEW_STORY,
        payload: undefined,
      });
      return;
    }

    // Find the next user's stories
    if (
      viewDirection === StoryViewDirectionType.Next &&
      conversationStoryIndex < conversationStories.length - 1
    ) {
      // Spec:
      // Tapping right advances you to the next un viewed story
      // If all stories are viewed, advance to the next viewed story
      // When you reach the newest story from a user, tapping right again
      //    should take you to the next user's oldest un viewed story or oldest
      //    story if all stories for the next user are viewed.
      // When you reach the newest story from the last user in the story list,
      //    tapping right should close the viewer
      // Touch area for tapping right should be 80% of width of the screen
      const nextConversationStoryIndex = conversationStoryIndex + 1;
      const conversationStory = conversationStories[nextConversationStoryIndex];

      const nextSelectedStoryData = getSelectedStoryDataForConversationId(
        dispatch,
        getState,
        conversationStory.conversationId
      );

      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex: 0,
          messageId: nextSelectedStoryData.storiesByConversationId[0].messageId,
          numStories: nextSelectedStoryData.numStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
        },
      });
      return;
    }

    // Find the previous user's stories
    if (
      viewDirection === StoryViewDirectionType.Previous &&
      conversationStoryIndex > 0
    ) {
      // Spec:
      // Tapping left takes you back to the previous story
      // When you reach the oldest story from a user, tapping left again takes
      //    you to the previous users oldest un viewed story or newest viewed
      //    story if all stories are viewed
      // If you tap left on the oldest story from the first user in the story
      //    list, it should re-start playback on that story
      // Touch area for tapping left should be 20% of width of the screen
      const nextConversationStoryIndex = conversationStoryIndex - 1;
      const conversationStory = conversationStories[nextConversationStoryIndex];

      const nextSelectedStoryData = getSelectedStoryDataForConversationId(
        dispatch,
        getState,
        conversationStory.conversationId
      );

      dispatch({
        type: VIEW_STORY,
        payload: {
          currentIndex: 0,
          messageId: nextSelectedStoryData.storiesByConversationId[0].messageId,
          numStories: nextSelectedStoryData.numStories,
          storyViewMode,
          unviewedStoryConversationIdsSorted,
        },
      });
      return;
    }

    // Could not meet any criteria, close the viewer
    dispatch({
      type: VIEW_STORY,
      payload: undefined,
    });
  };
};

export const actions = {
  deleteStoryForEveryone,
  loadStoryReplies,
  markStoryRead,
  queueStoryDownload,
  reactToStory,
  replyToStory,
  sendStoryMessage,
  sendStoryModalOpenStateChanged,
  storyChanged,
  toggleStoriesView,
  verifyStoryListMembers,
  viewUserStories,
  viewStory,
};

export const useStoriesActions = (): typeof actions => useBoundActions(actions);

// Reducer

export function getEmptyState(
  overrideState: Partial<StoriesStateType> = {}
): StoriesStateType {
  return {
    lastOpenedAtTimestamp: undefined,
    openedAtTimestamp: undefined,
    stories: [],
    ...overrideState,
  };
}

export function reducer(
  state: Readonly<StoriesStateType> = getEmptyState(),
  action: Readonly<StoriesActionType>
): StoriesStateType {
  if (action.type === TOGGLE_VIEW) {
    const isShowingStoriesView = Boolean(state.openedAtTimestamp);

    return {
      ...state,
      lastOpenedAtTimestamp: !isShowingStoriesView
        ? state.openedAtTimestamp || Date.now()
        : state.lastOpenedAtTimestamp,
      openedAtTimestamp: isShowingStoriesView ? undefined : Date.now(),
      replyState: undefined,
      sendStoryModalData: undefined,
      selectedStoryData: isShowingStoriesView
        ? undefined
        : state.selectedStoryData,
    };
  }

  if (action.type === 'MESSAGE_DELETED') {
    const nextStories = state.stories.filter(
      story => story.messageId !== action.payload.id
    );

    if (nextStories.length === state.stories.length) {
      return state;
    }

    return {
      ...state,
      stories: nextStories,
    };
  }

  if (action.type === STORY_CHANGED) {
    const newStory = pick(action.payload, [
      'attachment',
      'canReplyToStory',
      'conversationId',
      'deletedForEveryone',
      'expirationStartTimestamp',
      'expireTimer',
      'messageId',
      'reactions',
      'readAt',
      'readStatus',
      'sendStateByConversationId',
      'source',
      'sourceUuid',
      'storyDistributionListId',
      'timestamp',
      'type',
    ]);

    const prevStoryIndex = state.stories.findIndex(
      existingStory => existingStory.messageId === newStory.messageId
    );
    if (prevStoryIndex >= 0) {
      const prevStory = state.stories[prevStoryIndex];

      // Stories rarely need to change, here are the following exceptions:
      const isDownloadingAttachment = isDownloading(newStory.attachment);
      const hasAttachmentDownloaded =
        !isDownloaded(prevStory.attachment) &&
        isDownloaded(newStory.attachment);
      const hasAttachmentFailed =
        hasFailed(newStory.attachment) && !hasFailed(prevStory.attachment);
      const readStatusChanged = prevStory.readStatus !== newStory.readStatus;
      const reactionsChanged =
        prevStory.reactions?.length !== newStory.reactions?.length;
      const hasBeenDeleted =
        !prevStory.deletedForEveryone && newStory.deletedForEveryone;
      const hasSendStateChanged = !isEqual(
        prevStory.sendStateByConversationId,
        newStory.sendStateByConversationId
      );

      const shouldReplace =
        isDownloadingAttachment ||
        hasAttachmentDownloaded ||
        hasAttachmentFailed ||
        hasBeenDeleted ||
        hasSendStateChanged ||
        readStatusChanged ||
        reactionsChanged;
      if (!shouldReplace) {
        return state;
      }

      if (hasBeenDeleted) {
        return {
          ...state,
          stories: state.stories.filter(
            existingStory => existingStory.messageId !== newStory.messageId
          ),
        };
      }

      return {
        ...state,
        stories: replaceIndex(state.stories, prevStoryIndex, newStory),
      };
    }

    // Adding a new story
    const stories = [...state.stories, newStory].sort((a, b) =>
      a.timestamp > b.timestamp ? 1 : -1
    );

    return {
      ...state,
      stories,
    };
  }

  if (action.type === MARK_STORY_READ) {
    const { messageId, readAt } = action.payload;

    return {
      ...state,
      stories: state.stories.map(story => {
        if (story.messageId === messageId) {
          return {
            ...story,
            readAt,
            readStatus: ReadStatus.Viewed,
          };
        }

        return story;
      }),
    };
  }

  if (action.type === LOAD_STORY_REPLIES) {
    return {
      ...state,
      replyState: action.payload,
    };
  }

  if (action.type === 'MESSAGES_ADDED' && action.payload.isJustSent) {
    const stories = action.payload.messages.filter(isStory);
    if (!stories.length) {
      return state;
    }

    const newStories = stories
      .map(messageAttrs => getStoryDataFromMessageAttributes(messageAttrs))
      .filter(isNotNil);

    if (!newStories.length) {
      return state;
    }

    return {
      ...state,
      stories: [...state.stories, ...newStories],
    };
  }

  // For live updating of the story replies
  if (
    action.type === 'MESSAGE_CHANGED' &&
    state.replyState &&
    state.replyState.messageId === action.payload.data.storyId
  ) {
    const { replyState } = state;
    const messageIndex = replyState.replies.findIndex(
      reply => reply.id === action.payload.id
    );

    // New message
    if (messageIndex < 0) {
      return {
        ...state,
        replyState: {
          messageId: replyState.messageId,
          replies: [...replyState.replies, action.payload.data],
        },
      };
    }

    // Changed message, also handles DOE
    return {
      ...state,
      replyState: {
        messageId: replyState.messageId,
        replies: replaceIndex(
          replyState.replies,
          messageIndex,
          action.payload.data
        ),
      },
    };
  }

  if (action.type === REPLY_TO_STORY) {
    const { replyState } = state;
    if (!replyState) {
      return state;
    }

    return {
      ...state,
      replyState: {
        messageId: replyState.messageId,
        replies: [...replyState.replies, action.payload],
      },
    };
  }

  if (action.type === RESOLVE_ATTACHMENT_URL) {
    const { messageId, attachmentUrl } = action.payload;

    const storyIndex = state.stories.findIndex(
      existingStory => existingStory.messageId === messageId
    );

    if (storyIndex < 0) {
      return state;
    }

    const story = state.stories[storyIndex];

    if (!story.attachment) {
      return state;
    }

    const storyWithResolvedAttachment = {
      ...story,
      attachment: {
        ...story.attachment,
        url: attachmentUrl,
      },
    };

    return {
      ...state,
      stories: replaceIndex(
        state.stories,
        storyIndex,
        storyWithResolvedAttachment
      ),
    };
  }

  if (action.type === DOE_STORY) {
    return {
      ...state,
      stories: state.stories.filter(
        existingStory => existingStory.messageId !== action.payload
      ),
    };
  }

  if (action.type === VIEW_STORY) {
    return {
      ...state,
      selectedStoryData: action.payload,
    };
  }

  if (action.type === QUEUE_STORY_DOWNLOAD) {
    const storyIndex = state.stories.findIndex(
      story => story.messageId === action.payload
    );

    if (storyIndex < 0) {
      return state;
    }

    const existingStory = state.stories[storyIndex];

    return {
      ...state,
      stories: replaceIndex(state.stories, storyIndex, {
        ...existingStory,
        startedDownload: true,
      }),
    };
  }

  if (action.type === SEND_STORY_MODAL_OPEN_STATE_CHANGED) {
    if (action.payload) {
      return {
        ...state,
        sendStoryModalData: {
          untrustedUuids: [],
          verifiedUuids: [],
        },
      };
    }

    return {
      ...state,
      sendStoryModalData: undefined,
    };
  }

  if (action.type === LIST_MEMBERS_VERIFIED) {
    const sendStoryModalData = {
      untrustedUuids: [],
      verifiedUuids: [],
      ...(state.sendStoryModalData || {}),
    };

    const untrustedUuids = Array.from(
      new Set([
        ...sendStoryModalData.untrustedUuids,
        ...action.payload.untrustedUuids,
      ])
    );
    const verifiedUuids = Array.from(
      new Set([
        ...sendStoryModalData.verifiedUuids,
        ...action.payload.verifiedUuids,
      ])
    );

    return {
      ...state,
      sendStoryModalData: {
        ...sendStoryModalData,
        untrustedUuids,
        verifiedUuids,
      },
    };
  }

  return state;
}
