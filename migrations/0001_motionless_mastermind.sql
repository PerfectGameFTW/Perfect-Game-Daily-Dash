CREATE TABLE IF NOT EXISTS "square_catalog_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"square_catalog_object_id" text NOT NULL,
	"category_id" text,
	"category_name" text,
	"item_name" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "square_catalog_items_square_catalog_object_id_unique" UNIQUE("square_catalog_object_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "square_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"square_category_id" text NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "square_categories_square_category_id_unique" UNIQUE("square_category_id")
);
