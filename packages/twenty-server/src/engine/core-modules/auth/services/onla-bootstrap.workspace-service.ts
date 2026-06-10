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
import { OnlaSyncBookingActivityDto } from 'src/engine/core-modules/auth/dto/onla-sync-booking-activity.dto';
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
const ONLA_OBJECT_LABELS: Record<
  string,
  { singular: string; plural: string; nav: string; position: number }
> = {
  person: {
    singular: 'Клиент',
    plural: 'Клиенты',
    nav: 'Клиенты',
    position: 0,
  },
  opportunity: {
    singular: 'Заявка',
    plural: 'Заявки',
    nav: 'Заявки',
    position: 1,
  },
  task: {
    singular: 'Задача',
    plural: 'Нужно перезвонить',
    nav: 'Нужно перезвонить',
    position: 2,
  },
  note: {
    singular: 'Запись звонка',
    plural: 'История звонков',
    nav: 'История звонков',
    position: 3,
  },
  company: {
    singular: 'Компания',
    plural: 'Компании',
    nav: 'Компании',
    position: 20,
  },
};
const ONLA_FIELD_LABELS: Record<string, Record<string, string>> = {
  company: {
    createdAt: 'Создано',
    name: 'Название',
    noteTargets: 'История звонков',
    people: 'Клиенты',
    taskTargets: 'Задачи',
    updatedAt: 'Обновлено',
  },
  note: {
    bodyV2: 'Описание',
    createdAt: 'Создано',
    noteTargets: 'Клиент',
    title: 'Заголовок',
    updatedAt: 'Обновлено',
  },
  opportunity: {
    amount: 'Сумма',
    closeDate: 'Дата',
    company: 'Компания',
    createdAt: 'Создано',
    name: 'Заявка',
    pointOfContact: 'Клиент',
    stage: 'Статус',
    taskTargets: 'Задачи',
    noteTargets: 'История звонков',
    updatedAt: 'Обновлено',
  },
  person: {
    city: 'Город',
    company: 'Компания',
    createdAt: 'Создано',
    emails: 'Email',
    jobTitle: 'Тип',
    name: 'Имя',
    noteTargets: 'История звонков',
    phones: 'Телефон',
    taskTargets: 'Задачи',
    updatedAt: 'Обновлено',
  },
  task: {
    assignee: 'Ответственный',
    bodyV2: 'Комментарий',
    createdAt: 'Создано',
    dueAt: 'Срок',
    status: 'Статус',
    taskTargets: 'Клиент',
    title: 'Задача',
    updatedAt: 'Обновлено',
  },
};
const ONLA_VIEW_NAMES: Record<string, Record<string, string>> = {
  note: {
    FIELDS_WIDGET: 'Карточка звонка',
    INDEX: 'История звонков',
  },
  opportunity: {
    FIELDS_WIDGET: 'Карточка заявки',
    INDEX: 'Новые заявки',
    KANBAN: 'По статусу',
  },
  person: {
    FIELDS_WIDGET: 'Карточка клиента',
    INDEX: 'Клиенты',
  },
  task: {
    FIELDS_WIDGET: 'Карточка задачи',
    INDEX: 'Нужно перезвонить',
    KANBAN: 'По статусу',
  },
};

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
      await this.polishOnlaWorkspace(existingWorkspaceByOnlaClient.id);

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
      await this.polishOnlaWorkspace(existingWorkspace.id);

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
    await this.polishOnlaWorkspace(activatedWorkspace.id);

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

  async syncBookingActivity(payload: OnlaSyncBookingActivityDto) {
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
    // calendarEvent.iCalUid is the idempotency key — repeated pushes for the
    // same appointment update the one event instead of duplicating it.
    const iCalUid = `onla-booking:${payload.onla_appointment_id}`;
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const personId = await this.upsertBookingPerson(
        queryRunner,
        schema,
        phone,
        payload.caller_name ?? null,
        displayPhone,
      );
      const eventId = await this.upsertBookingCalendarEvent(
        queryRunner,
        schema,
        iCalUid,
        payload,
        displayPhone,
      );
      await this.ensureCalendarEventParticipant(
        queryRunner,
        schema,
        eventId,
        personId,
        payload,
        displayPhone,
      );

      await queryRunner.commitTransaction();

      return {
        status: 'ok',
        workspace_id: workspace.id,
        workspace_slug: workspace.subdomain,
        person_id: personId,
        calendar_event_id: eventId,
        booking_status: payload.status ?? null,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Person upsert by phone — same shape as upsertCallerPerson but driven by the
  // booking payload (kept separate so the call-sync path stays untouched).
  private async upsertBookingPerson(
    queryRunner: QueryRunner,
    schema: string,
    phone: {
      callingCode: string | null;
      countryCode: string | null;
      number: string | null;
    },
    callerName: string | null,
    displayPhone: string,
  ): Promise<string> {
    const name = callerName?.trim() || `Клиент ${displayPhone}`.slice(0, 120);

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
           set "updatedAt" = now(), "updatedByName" = $2
           where id = $1`,
          [existing[0].id, ONLA_CREATED_BY],
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
        name,
        phone.number,
        phone.countryCode,
        phone.callingCode,
        'Клиент Onla',
        ONLA_CREATED_BY,
      ],
    );

    return inserted[0].id;
  }

  // Insert/update the Twenty calendarEvent for this booking, keyed by iCalUid.
  // Cancelled/declined bookings stay on the calendar but are marked canceled.
  private async upsertBookingCalendarEvent(
    queryRunner: QueryRunner,
    schema: string,
    iCalUid: string,
    payload: OnlaSyncBookingActivityDto,
    displayPhone: string,
  ): Promise<string> {
    const startsAt = new Date(payload.scheduled_at);

    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('Invalid scheduled_at');
    }
    const durationMin =
      typeof payload.duration_minutes === 'number' && payload.duration_minutes > 0
        ? payload.duration_minutes
        : 30;
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
    const isCanceled =
      payload.status === 'cancelled' || payload.status === 'declined';
    const service = payload.service?.trim();
    const title = (service ? `Запись: ${service}` : 'Запись на приём').slice(
      0,
      200,
    );
    const description = [
      service ? `Услуга: ${service}` : null,
      `Клиент: ${displayPhone}`,
      payload.status ? `Статус: ${this.bookingStatusRu(payload.status)}` : null,
      payload.onla_appointment_link
        ? `Onla: ${payload.onla_appointment_link}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const existing = await queryRunner.query(
      `select id from ${schema}."calendarEvent"
       where "deletedAt" is null and "iCalUid" = $1
       limit 1`,
      [iCalUid],
    );

    if (existing[0]?.id) {
      await queryRunner.query(
        `update ${schema}."calendarEvent"
         set title = $2,
             "startsAt" = $3,
             "endsAt" = $4,
             "isCanceled" = $5,
             description = $6,
             "updatedAt" = now()
         where id = $1`,
        [existing[0].id, title, startsAt.toISOString(), endsAt.toISOString(), isCanceled, description],
      );

      return existing[0].id;
    }

    const inserted = await queryRunner.query(
      `insert into ${schema}."calendarEvent" (
        title,
        "isCanceled",
        "isFullDay",
        "startsAt",
        "endsAt",
        description,
        "iCalUid"
      ) values ($1, $2, false, $3, $4, $5, $6)
      returning id`,
      [title, isCanceled, startsAt.toISOString(), endsAt.toISOString(), description, iCalUid],
    );

    return inserted[0].id;
  }

  // Link the caller person to the event so it shows on the contact's Calendar
  // tab (the per-record timeline joins calendarEventParticipant.personId).
  private async ensureCalendarEventParticipant(
    queryRunner: QueryRunner,
    schema: string,
    calendarEventId: string,
    personId: string,
    payload: OnlaSyncBookingActivityDto,
    displayPhone: string,
  ) {
    const existing = await queryRunner.query(
      `select id from ${schema}."calendarEventParticipant"
       where "deletedAt" is null
         and "calendarEventId" = $1 and "personId" = $2
       limit 1`,
      [calendarEventId, personId],
    );

    if (existing[0]?.id) {
      return existing[0].id;
    }

    const handle = payload.caller_phone?.trim() || displayPhone;
    const displayName = payload.caller_name?.trim() || displayPhone;
    const inserted = await queryRunner.query(
      `insert into ${schema}."calendarEventParticipant" (
        "calendarEventId",
        "personId",
        handle,
        "displayName",
        "isOrganizer",
        "responseStatus"
      ) values ($1, $2, $3, $4, false, 'ACCEPTED')
      returning id`,
      [calendarEventId, personId, handle, displayName],
    );

    return inserted[0].id;
  }

  private bookingStatusRu(status: string): string {
    switch (status) {
      case 'confirmed':
        return 'подтверждено';
      case 'pending_confirmation':
        return 'ждёт подтверждения';
      case 'cancelled':
        return 'отменено';
      case 'declined':
        return 'отклонено';
      case 'rescheduled':
        return 'перенесено';
      default:
        return status;
    }
  }

  private async polishOnlaWorkspace(workspaceId: string) {
    for (const [nameSingular, labels] of Object.entries(ONLA_OBJECT_LABELS)) {
      await this.dataSource.query(
        `update core."objectMetadata"
         set "labelSingular" = $2,
             "labelPlural" = $3,
             "isLabelSyncedWithName" = false,
             "updatedAt" = now()
         where "workspaceId" = $1 and "nameSingular" = $4`,
        [workspaceId, labels.singular, labels.plural, nameSingular],
      );
    }

    for (const [objectName, fields] of Object.entries(ONLA_FIELD_LABELS)) {
      for (const [fieldName, label] of Object.entries(fields)) {
        await this.dataSource.query(
          `update core."fieldMetadata" field
           set label = $3,
               "isLabelSyncedWithName" = false,
               "updatedAt" = now()
           from core."objectMetadata" object
           where object.id = field."objectMetadataId"
             and field."workspaceId" = $1
             and object."workspaceId" = $1
             and object."nameSingular" = $2
             and field.name = $4`,
          [workspaceId, objectName, label, fieldName],
        );
      }
    }

    for (const [objectName, views] of Object.entries(ONLA_VIEW_NAMES)) {
      for (const [viewKey, name] of Object.entries(views)) {
        await this.dataSource.query(
          `update core.view view
           set name = $3,
               "updatedAt" = now()
           from core."objectMetadata" object
           where object.id = view."objectMetadataId"
             and view."workspaceId" = $1
             and object."workspaceId" = $1
             and object."nameSingular" = $2
             and (view.key::text = $4 or view.type::text = $4)`,
          [workspaceId, objectName, name, viewKey],
        );
      }
    }

    await this.dataSource.query(
      `delete from core."navigationMenuItem" nav
       where nav."workspaceId" = $1
         and (
           nav.type <> 'OBJECT'
           or not exists (
             select 1
             from core."objectMetadata" object
             where object.id = nav."targetObjectMetadataId"
               and object."nameSingular" = any($2::text[])
           )
         )`,
      [
        workspaceId,
        Object.keys(ONLA_OBJECT_LABELS).filter((name) => name !== 'company'),
      ],
    );

    for (const [objectName, labels] of Object.entries(ONLA_OBJECT_LABELS)) {
      if (objectName === 'company') {
        continue;
      }

      await this.dataSource.query(
        `update core."navigationMenuItem" nav
         set name = $3,
             position = $4,
             "updatedAt" = now()
         from core."objectMetadata" object
         where object.id = nav."targetObjectMetadataId"
           and nav."workspaceId" = $1
           and object."workspaceId" = $1
           and object."nameSingular" = $2`,
        [workspaceId, objectName, labels.nav, labels.position],
      );
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
