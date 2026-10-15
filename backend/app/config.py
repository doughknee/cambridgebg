"""Application configuration loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # App
    app_env: str = "development"
    app_base_url: str = "http://localhost:5173"
    backend_base_url: str = "http://localhost:8000"

    # Database
    database_url: str

    # Logto
    logto_endpoint: str = "http://localhost:3001"
    logto_admin_endpoint: str = "http://localhost:3002"
    # Server-to-server URL to reach Logto (e.g. from inside Docker use
    # http://logto:3001). Defaults to logto_endpoint when unset, which is
    # correct in production where both URLs collapse to the public hostname.
    logto_internal_url: str = ""
    logto_m2m_app_id: str = ""
    logto_m2m_app_secret: str = ""
    logto_app_id: str = ""
    logto_resource: str = "https://invoice-api.cambridgebg.com"

    # Anthropic
    anthropic_api_key: str = ""
    extraction_model: str = "claude-sonnet-4-5"

    # OpenAI fallback
    openai_api_key: str = ""
    openai_extraction_model: str = "gpt-4o"

    # R2
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = "cambridge-invoices"
    r2_endpoint: str = ""

    # Postmark
    postmark_webhook_secret: str = ""

    # QuickBooks
    qbo_client_id: str = ""
    qbo_client_secret: str = ""
    qbo_environment: str = "sandbox"
    qbo_redirect_uri: str = "http://localhost:8000/api/qbo/callback"
    qbo_default_expense_account_id: str = ""

    # Resend (outbound email + inbound webhook)
    resend_api_key: str = ""
    resend_from: str = "Cambridge Invoice Portal <onboarding@resend.dev>"
    # Svix-style HMAC secret for the inbound webhook. Paste verbatim
    # from Resend dashboard → Webhooks → Signing Secret. Includes the
    # ``whsec_`` prefix.
    resend_webhook_secret: str = ""

    # Discord channel webhook that receives "Report as suspicious" posts.
    # Empty → the Report action still rejects the invoice, just no post.
    discord_report_webhook_url: str = ""

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}

    @property
    def qbo_api_base(self) -> str:
        if self.qbo_environment == "production":
            return "https://quickbooks.api.intuit.com"
        return "https://sandbox-quickbooks.api.intuit.com"

    @property
    def cors_origins(self) -> list[str]:
        # Comma-separated additional origins could be added if needed
        return [self.app_base_url]

    @property
    def logto_internal_endpoint(self) -> str:
        """Effective URL for server-to-server calls to Logto."""
        return self.logto_internal_url or self.logto_endpoint


@lru_cache
def get_settings() -> Settings:
    return Settings()
