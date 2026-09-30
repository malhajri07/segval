// Constraints and indexes for the mobile B2C graph. Idempotent.
CREATE CONSTRAINT customer_id IF NOT EXISTS FOR (n:Customer) REQUIRE n.customer_id IS UNIQUE;
CREATE CONSTRAINT subscription_msisdn IF NOT EXISTS FOR (n:Subscription) REQUIRE n.msisdn IS UNIQUE;
CREATE CONSTRAINT plan_id IF NOT EXISTS FOR (n:Plan) REQUIRE n.plan_id IS UNIQUE;
CREATE CONSTRAINT device_tac IF NOT EXISTS FOR (n:Device) REQUIRE n.tac IS UNIQUE;
CREATE CONSTRAINT addon_id IF NOT EXISTS FOR (n:Addon) REQUIRE n.addon_id IS UNIQUE;
CREATE CONSTRAINT usage_id IF NOT EXISTS FOR (n:MonthlyUsage) REQUIRE n.usage_id IS UNIQUE;
CREATE CONSTRAINT city_name IF NOT EXISTS FOR (n:City) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT ticket_id IF NOT EXISTS FOR (n:Ticket) REQUIRE n.ticket_id IS UNIQUE;
CREATE CONSTRAINT segment_id IF NOT EXISTS FOR (n:Segment) REQUIRE n.id IS UNIQUE;
CREATE INDEX subscription_payment IF NOT EXISTS FOR (n:Subscription) ON (n.payment_type);
CREATE INDEX subscription_status IF NOT EXISTS FOR (n:Subscription) ON (n.status);
CREATE INDEX usage_month IF NOT EXISTS FOR (n:MonthlyUsage) ON (n.month);
CREATE INDEX customer_tier IF NOT EXISTS FOR (n:Customer) ON (n.value_tier);
