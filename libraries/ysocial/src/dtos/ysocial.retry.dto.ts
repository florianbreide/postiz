import { IsBoolean, IsOptional } from 'class-validator';

// POST /ysocial/posts/:id/retry. confirmUnclear: true only after a person
// checked that the post is not online yet (unclear outcome, PLAN 3.3 PR 19).
export class YsocialRetryDto {
  @IsOptional()
  @IsBoolean()
  confirmUnclear?: boolean;
}
