import { IsISO8601 } from 'class-validator';

// GET /ysocial/posts?from=&to= — both ISO 8601, "to" exclusive.
export class YsocialPostsQueryDto {
  @IsISO8601({ strict: true })
  from: string;

  @IsISO8601({ strict: true })
  to: string;
}
