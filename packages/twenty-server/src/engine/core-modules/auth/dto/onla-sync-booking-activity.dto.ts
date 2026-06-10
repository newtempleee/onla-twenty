import { IsNumber, IsOptional, IsString, Length } from 'class-validator';

/**
 * Payload for POST /onla/bootstrap/booking-activity.
 *
 * Mirrors the call-activity contract: the Onla worker pushes an appointment
 * (create / status change / reschedule) and the fork writes it into the
 * workspace as a Twenty calendarEvent linked to the caller person, so bookings
 * show up in the customer's CRM calendar. Idempotent by onla_appointment_id.
 */
export class OnlaSyncBookingActivityDto {
  @IsString()
  @Length(1, 128)
  onla_client_id: string;

  @IsString()
  @Length(1, 128)
  onla_appointment_id: string;

  @IsOptional()
  @IsString()
  @Length(0, 128)
  onla_call_id?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  caller_phone?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  caller_name?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 160)
  service?: string | null;

  @IsString()
  @Length(1, 40)
  scheduled_at: string; // ISO-8601

  @IsOptional()
  @IsNumber()
  duration_minutes?: number | null;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  status?: string | null; // pending_confirmation | confirmed | cancelled | declined | rescheduled

  @IsOptional()
  @IsString()
  @Length(0, 500)
  onla_appointment_link?: string | null;
}
