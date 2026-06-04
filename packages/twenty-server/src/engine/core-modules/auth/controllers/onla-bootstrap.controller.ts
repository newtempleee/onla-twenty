import {
  Body,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { timingSafeEqual } from 'crypto';

import { OnlaBootstrapWorkspaceDto } from 'src/engine/core-modules/auth/dto/onla-bootstrap-workspace.dto';
import { OnlaBootstrapWorkspaceResponseDto } from 'src/engine/core-modules/auth/dto/onla-bootstrap-workspace-response.dto';
import { OnlaSyncCallActivityDto } from 'src/engine/core-modules/auth/dto/onla-sync-call-activity.dto';
import { OnlaBootstrapWorkspaceService } from 'src/engine/core-modules/auth/services/onla-bootstrap.workspace-service';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';

@Controller('onla/bootstrap')
export class OnlaBootstrapController {
  constructor(
    private readonly onlaBootstrapService: OnlaBootstrapWorkspaceService,
  ) {}

  @Post('workspace')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async bootstrapWorkspace(
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() payload: OnlaBootstrapWorkspaceDto,
  ): Promise<OnlaBootstrapWorkspaceResponseDto> {
    this.assertAuthorized(authorizationHeader);

    return await this.onlaBootstrapService.bootstrapWorkspace(payload);
  }

  @Post('call-activity')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async syncCallActivity(
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() payload: OnlaSyncCallActivityDto,
  ) {
    this.assertAuthorized(authorizationHeader);

    return await this.onlaBootstrapService.syncCallActivity(payload);
  }

  private assertAuthorized(authorizationHeader: string | undefined) {
    const expectedSecret = process.env.ONLA_BOOTSTRAP_SHARED_SECRET;

    if (!expectedSecret) {
      throw new InternalServerErrorException(
        'ONLA_BOOTSTRAP_SHARED_SECRET is not configured',
      );
    }

    const providedSecret = authorizationHeader?.replace(/^Bearer\s+/i, '');

    if (!providedSecret || !this.safeCompare(providedSecret, expectedSecret)) {
      throw new UnauthorizedException('Invalid Onla bootstrap token');
    }
  }

  private safeCompare(value: string, expected: string) {
    const valueBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expected);

    if (valueBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(valueBuffer, expectedBuffer);
  }
}
