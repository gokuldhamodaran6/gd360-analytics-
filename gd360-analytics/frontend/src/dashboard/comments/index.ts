// 2026-10-07 (analyst canvas round): comment threads on blocks - the hook
// (GET/POST/PATCH/DELETE, optimistic) and the thread cards.
export { useComments, countsOf, NO_COMMENTS } from "./useComments";
export type { CommentsApi } from "./useComments";
export { CommentThreadCard, BlockComments, CommentsSheet, anchorShort } from "./CommentThread";
export type { BlockCommentsProps } from "./CommentThread";
// 2026-10-12 (round 38, team comments): the dashboard-wide comment state,
// the Comments panel and the @mention composer.
export { CommentsUiProvider, useCommentsUi, anchorHandler, cardClickHandler } from "./CommentsUi";
export type { CommentsUi, CommentBlockInfo } from "./CommentsUi";
export { CommentsPanel, CommentsButton, BlockCommentChip } from "./CommentsPanel";
export { MentionComposer, CommentBody } from "./MentionComposer";
