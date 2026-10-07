// 2026-10-07 (analyst canvas round): comment threads on blocks - the hook
// (GET/POST/PATCH/DELETE, optimistic) and the thread cards.
export { useComments, countsOf, NO_COMMENTS } from "./useComments";
export type { CommentsApi } from "./useComments";
export { CommentThreadCard, BlockComments, CommentsSheet, anchorShort } from "./CommentThread";
export type { BlockCommentsProps } from "./CommentThread";
