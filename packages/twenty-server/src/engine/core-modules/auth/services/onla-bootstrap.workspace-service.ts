import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { IsNull, Repository } from 'typeorm';

import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { UserWorkspaceService } from 'src/engine/core-modules/user-workspace/user-workspace.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

import { OnlaBootstrapWorkspaceDto } from 'src/engine/core-modules/auth/dto/onla-bootstrap-workspace.dto';
import { OnlaBootstrapWorkspaceResponseDto } from 'src/engine/core-modules/auth/dto/onla-bootstrap-workspace-response.dto';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';

const ONLA_CLIENT_ID_KEY = 'onla.clientId';
const ONLA_CLIENT_NAME_KEY = 'onla.clientName';
const ONLA_DEFAULT_FIELDS_KEY = 'onla.defaultFields';
const ONLA_DEFAULT_VIEWS_KEY = 'onla.defaultViews';
const ONLA_DEFAULT_LOCALE = 'ru-RU';
const DEFAULT_ONLA_CRM_VIEWS = [
  'Новые заявки',
  'Клиенты',
  'Записи',
  'Нужно перезвонить',
  'Эскалации',
  'История звонков Onla',
];
const DEFAULT_ONLA_CRM_FIELDS = {
  callOutcome: 'Итог звонка',
  callerPhone: 'Телефон',
  recordingLink: 'Запись разговора',
  transcriptExcerpt: 'Фрагмент разговора',
  bookingStatus: 'Статус записи',
};

@Injectable()
export class OnlaBootstrapWorkspaceService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(KeyValuePairEntity)
    private readonly keyValuePairRepository: Repository<KeyValuePairEntity>,
    private readonly signInUpService: SignInUpService,
    private readonly userService: UserService,
    private readonly userWorkspaceService: UserWorkspaceService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async bootstrapWorkspace(
    payload: OnlaBootstrapWorkspaceDto,
  ): Promise<OnlaBootstrapWorkspaceResponseDto> {
    const workspaceSlug = this.normalizeWorkspaceSlug(
      payload.workspace_slug ?? payload.client_slug,
    );
    const ownerEmail = payload.owner_email.trim().toLowerCase();
    const existingWorkspaceByOnlaClient =
      await this.findWorkspaceByOnlaClientId(payload.onla_client_id);

    if (existingWorkspaceByOnlaClient) {
      const owner = await this.ensureOwnerUser(ownerEmail, payload);
      await this.saveOnlaMapping(existingWorkspaceByOnlaClient.id, payload);

      if (
        existingWorkspaceByOnlaClient.activationStatus ===
        WorkspaceActivationStatus.ACTIVE
      ) {
        await this.userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace(
          owner,
          existingWorkspaceByOnlaClient,
        );
      }

      return this.toResponse(
        existingWorkspaceByOnlaClient,
        owner.id,
        'existing',
        payload,
      );
    }

    const existingWorkspace = await this.workspaceRepository.findOne({
      where: { subdomain: workspaceSlug },
    });

    if (existingWorkspace) {
      await this.assertOnlaClientMapping(existingWorkspace, payload);
      const owner = await this.ensureOwnerUser(ownerEmail, payload);
      await this.saveOnlaMapping(existingWorkspace.id, payload);

      if (
        existingWorkspace.activationStatus === WorkspaceActivationStatus.ACTIVE
      ) {
        await this.userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace(
          owner,
          existingWorkspace,
        );
      }

      return this.toResponse(existingWorkspace, owner.id, 'existing', payload);
    }

    const owner = await this.ensureOwnerUser(ownerEmail, payload);
    const { workspace } =
      await this.signInUpService.signUpOnNewWorkspaceForOnlaProvisioning(
        {
          type: 'existingUser',
          existingUser: owner,
        },
        {
          displayName: payload.client_name,
          subdomain: workspaceSlug,
        },
      );

    await this.workspaceService.activateWorkspace(owner, workspace, {
      displayName: payload.client_name,
    });

    const activatedWorkspace = await this.workspaceRepository.findOneOrFail({
      where: { id: workspace.id },
    });

    await this.saveOnlaMapping(activatedWorkspace.id, payload);

    return this.toResponse(activatedWorkspace, owner.id, 'created', payload);
  }

  private async ensureOwnerUser(
    ownerEmail: string,
    payload: OnlaBootstrapWorkspaceDto,
  ): Promise<UserEntity> {
    const existingUser = await this.userService.findUserByEmail(ownerEmail);

    if (existingUser) {
      await this.userRepository.update(existingUser.id, {
        isEmailVerified: true,
        locale: ONLA_DEFAULT_LOCALE,
      });

      return await this.userService.findUserByIdOrThrow(existingUser.id);
    }

    const user = await this.signInUpService.signUpUserForOnlaProvisioning({
      email: ownerEmail,
      firstName: payload.owner_first_name ?? '',
      lastName: payload.owner_last_name ?? '',
      picture: '',
      locale: ONLA_DEFAULT_LOCALE,
      isEmailVerified: true,
    });

    return await this.userService.findUserByIdOrThrow(user.id);
  }

  private async assertOnlaClientMapping(
    workspace: WorkspaceEntity,
    payload: OnlaBootstrapWorkspaceDto,
  ) {
    const mapping = await this.keyValuePairRepository.findOne({
      where: {
        key: ONLA_CLIENT_ID_KEY,
        workspaceId: workspace.id,
        userId: IsNull(),
      },
    });

    if (
      mapping?.value &&
      String(mapping.value) !== String(payload.onla_client_id)
    ) {
      throw new ConflictException(
        'Workspace slug is already linked to a different Onla client',
      );
    }

    if (!mapping) {
      await this.saveOnlaMapping(workspace.id, payload);
    }
  }

  private async findWorkspaceByOnlaClientId(
    onlaClientId: string,
  ): Promise<WorkspaceEntity | null> {
    const mapping = await this.keyValuePairRepository
      .createQueryBuilder('kvp')
      .where('kvp.key = :key', { key: ONLA_CLIENT_ID_KEY })
      .andWhere('kvp."userId" IS NULL')
      .andWhere('kvp.value = CAST(:value AS jsonb)', {
        value: JSON.stringify(onlaClientId),
      })
      .getOne();

    if (!mapping?.workspaceId) {
      return null;
    }

    return await this.workspaceRepository.findOne({
      where: { id: mapping.workspaceId },
    });
  }

  private async saveOnlaMapping(
    workspaceId: string,
    payload: OnlaBootstrapWorkspaceDto,
  ) {
    await this.saveWorkspaceConfig(
      workspaceId,
      ONLA_CLIENT_ID_KEY,
      payload.onla_client_id,
    );
    await this.saveWorkspaceConfig(
      workspaceId,
      ONLA_CLIENT_NAME_KEY,
      payload.client_name,
    );
    await this.saveWorkspaceConfig(
      workspaceId,
      ONLA_DEFAULT_VIEWS_KEY,
      this.defaultViews(payload),
    );
    await this.saveWorkspaceConfig(
      workspaceId,
      ONLA_DEFAULT_FIELDS_KEY,
      this.defaultFields(payload),
    );
  }

  private async saveWorkspaceConfig(
    workspaceId: string,
    key: string,
    value: unknown,
  ) {
    const existing = await this.keyValuePairRepository.findOne({
      where: { key, workspaceId, userId: IsNull() },
    });

    await this.keyValuePairRepository.save({
      id: existing?.id,
      workspaceId,
      userId: null,
      key,
      value: value as unknown as JSON,
      type: KeyValuePairType.CONFIG_VARIABLE,
      textValueDeprecated: null,
    });
  }

  private normalizeWorkspaceSlug(slug: string) {
    const normalizedSlug = slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63);

    if (normalizedSlug.length < 3) {
      throw new BadRequestException(
        'Workspace slug must be at least 3 characters',
      );
    }

    return normalizedSlug;
  }

  private toResponse(
    workspace: WorkspaceEntity,
    ownerUserId: string | null,
    provisioningResult: 'created' | 'existing',
    payload: OnlaBootstrapWorkspaceDto,
  ): OnlaBootstrapWorkspaceResponseDto {
    const baseUrl =
      process.env.ONLA_CRM_PUBLIC_URL ??
      process.env.SERVER_URL ??
      'https://crm.onla-ai.ru';

    return {
      status: 'ready',
      external_workspace_id: workspace.id,
      workspace_id: workspace.id,
      workspace_slug: workspace.subdomain,
      crm_url: baseUrl,
      workspace_url: baseUrl,
      locale: ONLA_DEFAULT_LOCALE,
      api_secret_ref: 'onla-fork-service-token',
      owner_user_id: ownerUserId,
      provisioning_result: provisioningResult,
      default_views: this.defaultViews(payload),
      default_fields: this.defaultFields(payload),
    };
  }

  private defaultViews(payload: OnlaBootstrapWorkspaceDto): string[] {
    const views = payload.default_views
      ?.map((view) => view.trim())
      .filter(Boolean);

    return views?.length ? views.slice(0, 12) : DEFAULT_ONLA_CRM_VIEWS;
  }

  private defaultFields(
    payload: OnlaBootstrapWorkspaceDto,
  ): Record<string, string> {
    const fields = payload.default_fields ?? {};
    const entries = Object.entries(fields)
      .map(([key, value]) => [key.trim(), String(value).trim()] as const)
      .filter(([key, value]) => key && value);

    return entries.length
      ? Object.fromEntries(entries)
      : DEFAULT_ONLA_CRM_FIELDS;
  }
}
