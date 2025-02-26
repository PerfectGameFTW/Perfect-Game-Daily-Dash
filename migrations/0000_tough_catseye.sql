CREATE TABLE "gift_card_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"gift_card_id" integer NOT NULL,
	"amount" real NOT NULL,
	"transaction_id" integer NOT NULL,
	"timestamp" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"square_id" text NOT NULL,
	"amount" real NOT NULL,
	"redeemed_amount" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"purchase_date" timestamp NOT NULL,
	"square_data" jsonb,
	CONSTRAINT "gift_cards_square_id_unique" UNIQUE("square_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"square_id" text NOT NULL,
	"amount" real NOT NULL,
	"category_id" text NOT NULL,
	"status" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"square_data" jsonb,
	CONSTRAINT "transactions_square_id_unique" UNIQUE("square_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
