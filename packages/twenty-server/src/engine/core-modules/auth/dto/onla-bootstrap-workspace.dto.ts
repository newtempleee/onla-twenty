import {
  ArrayMaxSize,
  IsEmail,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class OnlaBootstrapWorkspaceDto {
  @IsString()
  @Length(1, 128)
  onla_client_id: string;

  @IsString()
  @Length(3, 63)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  client_slug: string;

  @IsOptional()
  @IsString()
  @Length(3, 63)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  workspace_slug?: string;

  @IsString()
  @Length(1, 120)
  client_name: string;

  @IsEmail()
  owner_email: string;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  owner_first_name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  owner_last_name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  default_views?: string[];

  @IsOptional()
  @IsObject()
  default_fields?: Record<string, string>;
}
