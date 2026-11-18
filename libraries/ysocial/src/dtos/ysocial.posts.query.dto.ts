import { IsIn, IsISO8601, IsOptional } from 'class-validator';

// GET /ysocial/posts?from=&to= — both ISO 8601, "to" exclusive.
export class YsocialPostsQueryDto {
  @IsISO8601({ strict: true })
  from: string;

  @IsISO8601({ strict: true })
  to: string;
}

// GET /ysocial/posts/:id?media=sha256 — the SHA-256 of each medium as well
// (K6), only when asked: it reads the files.
export class YsocialPostQueryDto {
  @IsOptional()
  @IsIn(['sha256'])
  media?: 'sha256';
}
