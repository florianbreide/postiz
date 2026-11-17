import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  INBOX_CURSOR_PATTERN,
  INBOX_REPLY_MAX_LENGTH,
  INBOX_TIME_PATTERN,
} from '../inbox/inbox.rules';

// GET /ysocial/inbox/integrations/:id/items?since=&olderThan=&postsAfter=&cursor=
// (PR 73). since: comments and replies from this time on. olderThan: the
// posts created before it instead of the window of the last 30 days,
// postsAfter: with olderThan, not the posts before this time. cursor:
// nextCursor of the page before, with the same since, olderThan and
// postsAfter. Times with date and time (INBOX_TIME_PATTERN).
export class YsocialInboxItemsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(INBOX_TIME_PATTERN, { message: 'since needs a date and a time' })
  since?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(INBOX_TIME_PATTERN, {
    message: 'olderThan needs a date and a time',
  })
  olderThan?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(INBOX_TIME_PATTERN, {
    message: 'postsAfter needs a date and a time',
  })
  postsAfter?: string;

  @IsOptional()
  @Matches(INBOX_CURSOR_PATTERN, { message: 'cursor is invalid' })
  cursor?: string;
}

// ?postId= on the routes of one comment (PR 73): the post of the comment as
// the hub knows it from items. Facebook searches the comment only under this
// post, after it checked the post belongs to the Page. Without it the posts
// of the last 30 days.
export class YsocialInboxCommentQueryDto {
  @IsOptional()
  @Matches(/^[0-9_]{1,64}$/, { message: 'postId is invalid' })
  postId?: string;
}

// POST /ysocial/inbox/integrations/:id/comments/:commentId/replies. The text
// a person wrote or approved in the hub (rule 2).
export class YsocialInboxReplyDto {
  @IsString()
  @MaxLength(INBOX_REPLY_MAX_LENGTH)
  @Matches(/\S/, { message: 'message must not be blank' })
  message: string;
}

// POST /ysocial/inbox/integrations/:id/comments/:commentId/hide.
// hide: true hides the comment, false shows it again.
export class YsocialInboxHideDto {
  @IsBoolean()
  hide: boolean;
}

// DELETE /ysocial/inbox/integrations/:id/comments/:commentId.
// confirmDelete: true only after a person confirmed in the hub.
export class YsocialInboxDeleteDto {
  @IsOptional()
  @IsBoolean()
  confirmDelete?: boolean;
}
