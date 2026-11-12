import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { INBOX_REPLY_MAX_LENGTH } from '../inbox/inbox.rules';

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
