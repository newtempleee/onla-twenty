import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class OnlaSyncCallActivityDto {
  @IsString()
  @Length(1, 128)
  onla_client_id: string;

  @IsString()
  @Length(1, 128)
  onla_call_id: string;

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
  @Length(0, 80)
  call_outcome?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  booking_status?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  started_at?: string | null;

  @IsOptional()
  @IsNumber()
  duration_sec?: number | null;

  @IsOptional()
  @IsNumber()
  confidence?: number | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  summary?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  transcript_excerpt?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  recording_link?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  onla_call_link?: string | null;

  @IsOptional()
  @IsBoolean()
  requires_callback?: boolean;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
