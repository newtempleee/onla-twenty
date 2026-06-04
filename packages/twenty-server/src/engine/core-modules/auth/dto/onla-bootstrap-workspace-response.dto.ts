export type OnlaBootstrapWorkspaceResponseDto = {
  status: 'ready';
  external_workspace_id: string;
  workspace_id: string;
  workspace_slug: string;
  crm_url: string;
  workspace_url: string;
  locale: 'ru-RU';
  api_secret_ref: string;
  owner_user_id: string | null;
  provisioning_result: 'created' | 'existing';
};
