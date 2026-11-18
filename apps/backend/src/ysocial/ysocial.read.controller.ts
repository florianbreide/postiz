import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import {
  YsocialPostQueryDto,
  YsocialPostsQueryDto,
} from '../../../../libraries/ysocial/src/dtos/ysocial.posts.query.dto';

// Read API for the hub (PLAN 3.3 PR 18). Internal like /ysocial/status: the
// reverse proxy blocks /api/ysocial/* from outside. Fixed field lists, see
// libraries/ysocial/src/database/ysocial.read.repository.ts.
@ApiExcludeController()
@UseGuards(YsocialTokenGuard)
@Controller('/ysocial')
export class YsocialReadController {
  constructor(private _readService: YsocialReadService) {}

  @Get('/customers')
  getCustomers() {
    return this._readService.getCustomers();
  }

  @Get('/integrations')
  getIntegrations() {
    return this._readService.getIntegrations();
  }

  @Get('/posts')
  getPosts(@Query() query: YsocialPostsQueryDto) {
    return this._readService.getPosts(query.from, query.to);
  }

  // The post with the comments of its thread (PLAN 3.3 PR 36), with
  // ?media=sha256 the SHA-256 of each medium (K6).
  @Get('/posts/:id')
  getPost(@Param('id') id: string, @Query() query: YsocialPostQueryDto) {
    return this._readService.getPost(id, query.media === 'sha256');
  }
}
