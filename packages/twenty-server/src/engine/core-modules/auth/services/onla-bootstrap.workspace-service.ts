import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, IsNull, type QueryRunner, Repository } from 'typeorm';

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
import { OnlaSyncCallActivityDto } from 'src/engine/core-modules/auth/dto/onla-sync-call-activity.dto';
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
const ONLA_CREATED_BY = 'Onla';

type SyncedCallActivity = {
  status: 'ok';
  workspace_id: string;
  workspace_slug: string;
  person_id: string;
  note_id: string;
  task_id: string | null;
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
    private readonly dataSource: DataSource,
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

    await this.workspaceService.activateWorkspace(
      owner,
      workspace,
      {
        displayName: payload.client_name,
      },
      { skipPrefill: true },
    );

    const activatedWorkspace = await this.workspaceRepository.findOneOrFail({
      where: { id: workspace.id },
    });

    await this.saveOnlaMapping(activatedWorkspace.id, payload);

    return this.toResponse(activatedWorkspace, owner.id, 'created', payload);
  }

  async syncCallActivity(
    payload: OnlaSyncCallActivityDto,
  ): Promise<SyncedCallActivity> {
    const workspace = await this.findWorkspaceByOnlaClientId(
      payload.onla_client_id,
    );

    if (!workspace) {
      throw new BadRequestException('Onla CRM workspace was not found');
    }

    if (workspace.activationStatus !== WorkspaceActivationStatus.ACTIVE) {
      throw new BadRequestException('Onla CRM workspace is not active');
    }

    if (!workspace.databaseSchema) {
      throw new BadRequestException('Onla CRM workspace schema is not ready');
    }

    const schema = this.quoteIdentifier(workspace.databaseSchema);
    const phone = this.parsePhone(payload.caller_phone);
    const displayPhone = payload.caller_phone?.trim() || 'без номера';
    const marker = `[onla_call_id:${payload.onla_call_id}]`;
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const personId = await this.upsertCallerPerson(
        queryRunner,
        schema,
        phone,
        payload,
        displayPhone,
      );
      const noteId = await this.upsertCallNote(
        queryRunner,
        schema,
        personId,
        marker,
        payload,
        displayPhone,
      );
      const taskId = await this.upsertCallbackTaskIfNeeded(
        queryRunner,
        schema,
        personId,
        marker,
        payload,
        displayPhone,
      );

      await queryRunner.commitTransaction();

      return {
        status: 'ok',
        workspace_id: workspace.id,
        workspace_slug: workspace.subdomain,
        person_id: personId,
        note_id: noteId,
        task_id: taskId,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async upsertCallerPerson(
    queryRunner: QueryRunner,
    schema: string,
    phone: {
      callingCode: string | null;
      countryCode: string | null;
      number: string | null;
    },
    payload: OnlaSyncCallActivityDto,
    displayPhone: string,
  ): Promise<string> {
    const callerName =
      payload.caller_name?.trim() || `Клиент ${displayPhone}`.slice(0, 120);

    if (phone.callingCode && phone.number) {
      const existing = await queryRunner.query(
        `select id from ${schema}.person
         where "deletedAt" is null
           and "phonesPrimaryPhoneCallingCode" = $1
           and "phonesPrimaryPhoneNumber" = $2
         limit 1`,
        [phone.callingCode, phone.number],
      );

      if (existing[0]?.id) {
        await queryRunner.query(
          `update ${schema}.person
           set "updatedAt" = now(),
               "updatedByName" = $2,
               "jobTitle" = coalesce(nullif("jobTitle", ''), $3)
           where id = $1`,
          [existing[0].id, ONLA_CREATED_BY, 'Клиент Onla'],
        );

        return existing[0].id;
      }
    }

    const inserted = await queryRunner.query(
      `insert into ${schema}.person (
        "nameFirstName",
        "nameLastName",
        "phonesPrimaryPhoneNumber",
        "phonesPrimaryPhoneCountryCode",
        "phonesPrimaryPhoneCallingCode",
        "phonesAdditionalPhones",
        "jobTitle",
        "createdByName",
        "updatedByName"
      ) values ($1, '', $2, $3, $4, '[]'::jsonb, $5, $6, $6)
      returning id`,
      [
        callerName,
        phone.number,
        phone.countryCode,
        phone.callingCode,
        'Клиент Onla',
        ONLA_CREATED_BY,
      ],
    );

    return inserted[0].id;
  }

  private async upsertCallNote(
    queryRunner: QueryRunner,
    schema: string,
    personId: string,
    marker: string,
    payload: OnlaSyncCallActivityDto,
    displayPhone: string,
  ): Promise<string> {
    const title = `Звонок ${displayPhone}`.slice(0, 200);
    const markdown = this.callMarkdown(marker, payload, displayPhone);
    const existing = await queryRunner.query(
      `select id from ${schema}.note
       where "deletedAt" is null and "bodyV2Markdown" like $1
       limit 1`,
      [`%${marker}%`],
    );
    const noteId = existing[0]?.id;

    if (noteId) {
      await queryRunner.query(
        `update ${schema}.note
         set title = $2,
             "bodyV2Markdown" = $3,
             "updatedAt" = now(),
             "updatedByName" = $4
         where id = $1`,
        [noteId, title, markdown, ONLA_CREATED_BY],
      );
      await this.ensureNoteTarget(queryRunner, schema, noteId, personId);

      return noteId;
    }

    const inserted = await queryRunner.query(
      `insert into ${schema}.note (
        title,
        "bodyV2Markdown",
        "createdByName",
        "updatedByName"
      ) values ($1, $2, $3, $3)
      returning id`,
      [title, markdown, ONLA_CREATED_BY],
    );

    await this.ensureNoteTarget(queryRunner, schema, inserted[0].id, personId);

    return inserted[0].id;
  }

  private async upsertCallbackTaskIfNeeded(
    queryRunner: QueryRunner,
    schema: string,
    personId: string,
    marker: string,
    payload: OnlaSyncCallActivityDto,
    displayPhone: string,
  ): Promise<string | null> {
    if (!this.requiresCallback(payload)) {
      return null;
    }

    const title = `Перезвонить ${displayPhone}`.slice(0, 200);
    const markdown = [
      `${marker}`,
      '',
      'Клиент попросил внимания менеджера или звонок требует ручной проверки.',
      payload.onla_call_link ? `Ссылка Onla: ${payload.onla_call_link}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const existing = await queryRunner.query(
      `select id from ${schema}.task
       where "deletedAt" is null and "bodyV2Markdown" like $1
       limit 1`,
      [`%${marker}%`],
    );
    const taskId = existing[0]?.id;

    if (taskId) {
      await queryRunner.query(
        `update ${schema}.task
         set title = $2,
             "bodyV2Markdown" = $3,
             "updatedAt" = now(),
             "updatedByName" = $4
         where id = $1`,
        [taskId, title, markdown, ONLA_CREATED_BY],
      );
      await this.ensureTaskTarget(queryRunner, schema, taskId, personId);

      return taskId;
    }

    const inserted = await queryRunner.query(
      `insert into ${schema}.task (
        title,
        "bodyV2Markdown",
        "dueAt",
        status,
        "createdByName",
        "updatedByName"
      ) values ($1, $2, now() + interval '1 hour', 'TODO', $3, $3)
      returning id`,
      [title, markdown, ONLA_CREATED_BY],
    );

    await this.ensureTaskTarget(queryRunner, schema, inserted[0].id, personId);

    return inserted[0].id;
  }

  private async ensureNoteTarget(
    queryRunner: QueryRunner,
    schema: string,
    noteId: string,
    personId: string,
  ) {
    const existing = await queryRunner.query(
      `select id from ${schema}."noteTarget"
       where "deletedAt" is null and "noteId" = $1 and "targetPersonId" = $2
       limit 1`,
      [noteId, personId],
    );

    if (!existing[0]?.id) {
      await queryRunner.query(
        `insert into ${schema}."noteTarget" (
          "noteId",
          "targetPersonId",
          "createdByName",
          "updatedByName"
        ) values ($1, $2, $3, $3)`,
        [noteId, personId, ONLA_CREATED_BY],
      );
    }
  }

  private async ensureTaskTarget(
    queryRunner: QueryRunner,
    schema: string,
    taskId: string,
    personId: string,
  ) {
    const existing = await queryRunner.query(
      `select id from ${schema}."taskTarget"
       where "deletedAt" is null and "taskId" = $1 and "targetPersonId" = $2
       limit 1`,
      [taskId, personId],
    );

    if (!existing[0]?.id) {
      await queryRunner.query(
        `insert into ${schema}."taskTarget" (
          "taskId",
          "targetPersonId",
          "createdByName",
          "updatedByName"
        ) values ($1, $2, $3, $3)`,
        [taskId, personId, ONLA_CREATED_BY],
      );
    }
  }

  private callMarkdown(
    marker: string,
    payload: OnlaSyncCallActivityDto,
    displayPhone: string,
  ) {
    return [
      marker,
      '',
      `Телефон: ${displayPhone}`,
      payload.started_at ? `Когда: ${payload.started_at}` : null,
      typeof payload.duration_sec === 'number'
        ? `Длительность: ${Math.round(payload.duration_sec)} сек.`
        : null,
      payload.call_outcome ? `Итог звонка: ${payload.call_outcome}` : null,
      payload.booking_status
        ? `Статус записи: ${payload.booking_status}`
        : null,
      typeof payload.confidence === 'number'
        ? `Уверенность AI: ${Math.round(payload.confidence * 100)}%`
        : null,
      '',
      payload.summary ? `Кратко: ${payload.summary}` : null,
      payload.transcript_excerpt
        ? `Фрагмент разговора: ${payload.transcript_excerpt}`
        : null,
      payload.recording_link
        ? `Запись разговора: ${payload.recording_link}`
        : null,
      payload.onla_call_link
        ? `Карточка звонка в Onla: ${payload.onla_call_link}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private requiresCallback(payload: OnlaSyncCallActivityDto): boolean {
    if (payload.requires_callback) {
      return true;
    }

    const text = [
      payload.call_outcome,
      payload.booking_status,
      payload.summary,
      payload.transcript_excerpt,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return /перезвон|callback|эскалац|escalat|человек|manager|human|transfer/.test(
      text,
    );
  }

  private parsePhone(raw?: string | null): {
    callingCode: string | null;
    countryCode: string | null;
    number: string | null;
  } {
    const digits = raw?.replace(/\D/g, '') ?? '';

    if (!digits) {
      return { callingCode: null, countryCode: null, number: null };
    }

    if (
      digits.length === 11 &&
      (digits.startsWith('7') || digits.startsWith('8'))
    ) {
      return {
        callingCode: '+7',
        countryCode: 'RU',
        number: digits.slice(1),
      };
    }

    if (digits.length > 10 && digits.startsWith('971')) {
      return {
        callingCode: '+971',
        countryCode: 'AE',
        number: digits.slice(3),
      };
    }

    return {
      callingCode: raw?.trim().startsWith('+')
        ? `+${digits.slice(0, -10)}`
        : null,
      countryCode: null,
      number: digits.length > 10 ? digits.slice(-10) : digits,
    };
  }

  private quoteIdentifier(identifier: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      throw new BadRequestException('Invalid workspace schema');
    }

    return `"${identifier}"`;
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
