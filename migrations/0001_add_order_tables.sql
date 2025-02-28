CREATE TABLE "orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "square_id" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "total_money" real NOT NULL,
  "total_tax" real NOT NULL,
  "total_discount" real NOT NULL,
  "created_at" timestamp NOT NULL,
  "closed_at" timestamp,
  "transaction_id" integer REFERENCES "transactions"("id"),
  "source" text NOT NULL,
  "square_data" jsonb
);

CREATE TABLE "order_line_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "quantity" integer NOT NULL,
  "base_price_money" real NOT NULL,
  "total_money" real NOT NULL,
  "square_data" jsonb
);

CREATE TABLE "order_modifiers" (
  "id" serial PRIMARY KEY NOT NULL,
  "line_item_id" integer NOT NULL REFERENCES "order_line_items"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "base_price_money" real,
  "total_price_money" real,
  "square_data" jsonb
);

CREATE TABLE "order_discounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "percentage" real,
  "amount_money" real,
  "applied_money" real NOT NULL,
  "scope" text NOT NULL,
  "square_data" jsonb
);
