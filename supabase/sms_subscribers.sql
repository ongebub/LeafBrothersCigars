CREATE TABLE IF NOT EXISTS sms_subscribers (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name    TEXT,
  phone         TEXT UNIQUE NOT NULL,
  location_preference TEXT,
  consent       BOOLEAN NOT NULL,
  consent_text  TEXT,
  terms_agreed  BOOLEAN,
  terms_agreed_text TEXT,
  source        TEXT DEFAULT 'web_form',
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
