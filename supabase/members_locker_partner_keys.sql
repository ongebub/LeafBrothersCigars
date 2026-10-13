-- Half Locker partner + key return tracking on public.members.
--
-- Applied 2026-10-13.  It has to exist BEFORE the code that
-- writes these columns is deployed: api/stripewebhook.js sets them on every
-- signup and cancellation, and admin.html saves two of them, so with the
-- columns missing every one of those writes fails.
--
-- Every column is nullable with no default, so running it early changes
-- nothing for existing rows or for the code that is live today.  Existing
-- members keep key_fee_agreed_at NULL, which is what exempts them: only
-- someone who ticked the key-return box at signup can ever owe the fee.

alter table public.members
  add column if not exists locker_partner     text,         -- who a Half Locker is shared with, as typed at signup
  add column if not exists key_fee_agreed_at  timestamptz,  -- when they ticked the key-return box
  add column if not exists cancelled_at       timestamptz,  -- when the membership actually ended (Stripe ended_at)
  add column if not exists key_returned_at    timestamptz,  -- ticked by staff in admin.html
  add column if not exists key_fee_charged_at timestamptz,  -- set once the $15 fee has been taken; never charge twice
  add column if not exists key_fee_failed_at  timestamptz,  -- a charge was tried and declined; not retried
  add column if not exists key_fee_error      text,         -- why it was declined
  add column if not exists key_fee_payment_id text;         -- the Stripe payment, for a refund if the key turns up
