import { db } from '../db';
import { eq, sql } from 'drizzle-orm';
import { SquareClient, SquareEnvironment } from 'square';
import {
  squareCategories,
  squareCatalogItems,
  type InsertSquareCategory,
  type InsertSquareCatalogItem,
  type SquareCatalogItem,
} from '../../shared/schema';

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: SquareEnvironment.Production,
});

const catalogItemCache = new Map<string, string | null>();
let cacheLoadedAt: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function ensureCacheLoaded(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && catalogItemCache.size > 0) {
    return;
  }
  const rows = await db.select().from(squareCatalogItems);
  catalogItemCache.clear();
  for (const row of rows) {
    catalogItemCache.set(row.squareCatalogObjectId, row.categoryName || null);
  }
  cacheLoadedAt = Date.now();
}

export function lookupCategorySync(catalogObjectId: string | null | undefined): string | null {
  if (!catalogObjectId) return null;
  const cached = catalogItemCache.get(catalogObjectId);
  return cached !== undefined ? cached : null;
}

export async function preloadCatalogCache(): Promise<void> {
  cacheLoadedAt = 0;
  await ensureCacheLoaded();
  console.log(`[CatalogService] Preloaded ${catalogItemCache.size} catalog items into memory`);
}

export async function lookupCategoryByCatalogObjectId(
  catalogObjectId: string | null | undefined
): Promise<string | null> {
  if (!catalogObjectId) return null;
  await ensureCacheLoaded();
  const cached = catalogItemCache.get(catalogObjectId);
  if (cached !== undefined) return cached;
  const rows = await db
    .select()
    .from(squareCatalogItems)
    .where(eq(squareCatalogItems.squareCatalogObjectId, catalogObjectId))
    .limit(1);
  if (rows.length > 0) {
    const name = rows[0].categoryName || null;
    catalogItemCache.set(catalogObjectId, name);
    return name;
  }
  catalogItemCache.set(catalogObjectId, null);
  return null;
}

export async function syncCatalog(): Promise<{
  categories: number;
  items: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let categoryCount = 0;
  let itemCount = 0;

  try {
    console.log('[CatalogSync] Starting catalog sync from Square...');

    const categoryMap = new Map<string, string>();

    try {
      let catPage = await squareClient.catalog.list({ types: 'CATEGORY' });
      while (true) {
        const objects = catPage.data ?? [];
        for (const obj of objects) {
          if (obj.type !== 'CATEGORY' || !obj.categoryData) continue;
          const catId = obj.id as string;
          if (!catId) continue;
          const catName = obj.categoryData.name || 'Unnamed Category';
          categoryMap.set(catId, catName);

          await db
            .insert(squareCategories)
            .values({
              squareCategoryId: catId,
              name: catName,
              updatedAt: new Date(),
            } satisfies InsertSquareCategory)
            .onConflictDoUpdate({
              target: squareCategories.squareCategoryId,
              set: {
                name: catName,
                updatedAt: new Date(),
              },
            });
          categoryCount++;
        }
        if (!catPage.hasNextPage() || objects.length === 0) break;
        catPage = await catPage.getNextPage();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Error fetching categories: ${msg}`);
      console.error('[CatalogSync] Error fetching categories:', msg);
    }

    console.log(`[CatalogSync] Synced ${categoryCount} categories`);

    try {
      let itemPage = await squareClient.catalog.list({ types: 'ITEM' });
      while (true) {
        const itemObjects = itemPage.data ?? [];
        for (const obj of itemObjects) {
        if (obj.type !== 'ITEM' || !obj.itemData) continue;

        const itemData = obj.itemData;
        const catalogObjectId = obj.id;
        const itemName = itemData.name || 'Unnamed Item';

        let categoryId: string | null = null;
        let categoryName: string | null = null;

        if (itemData.categories && itemData.categories.length > 0) {
          const firstCat = itemData.categories[0];
          categoryId = firstCat.id || null;
          if (categoryId && categoryMap.has(categoryId)) {
            categoryName = categoryMap.get(categoryId)!;
          }
        }

        if (!categoryId && itemData.reportingCategory?.id) {
          categoryId = itemData.reportingCategory.id;
          if (categoryId && categoryMap.has(categoryId)) {
            categoryName = categoryMap.get(categoryId)!;
          }
        }

        if (!categoryId && itemData.categoryId) {
          categoryId = itemData.categoryId;
          if (categoryId && categoryMap.has(categoryId)) {
            categoryName = categoryMap.get(categoryId)!;
          }
        }

        if (!categoryName && categoryId) {
          const catRows = await db
            .select()
            .from(squareCategories)
            .where(eq(squareCategories.squareCategoryId, categoryId))
            .limit(1);
          if (catRows.length > 0) {
            categoryName = catRows[0].name;
          }
        }

        await db
          .insert(squareCatalogItems)
          .values({
            squareCatalogObjectId: catalogObjectId,
            categoryId,
            categoryName,
            itemName,
            updatedAt: new Date(),
          } satisfies InsertSquareCatalogItem)
          .onConflictDoUpdate({
            target: squareCatalogItems.squareCatalogObjectId,
            set: {
              categoryId,
              categoryName,
              itemName,
              updatedAt: new Date(),
            },
          });
        itemCount++;

        if (itemData.variations && Array.isArray(itemData.variations)) {
          for (const variation of itemData.variations) {
            if (!variation.id) continue;
            const varName = 'itemVariationData' in variation && variation.itemVariationData
              && typeof variation.itemVariationData === 'object'
              && 'name' in variation.itemVariationData
              && typeof variation.itemVariationData.name === 'string'
              ? `${itemName} - ${variation.itemVariationData.name}`
              : itemName;

            await db
              .insert(squareCatalogItems)
              .values({
                squareCatalogObjectId: variation.id,
                categoryId,
                categoryName,
                itemName: varName,
                updatedAt: new Date(),
              } satisfies InsertSquareCatalogItem)
              .onConflictDoUpdate({
                target: squareCatalogItems.squareCatalogObjectId,
                set: {
                  categoryId,
                  categoryName,
                  itemName: varName,
                  updatedAt: new Date(),
                },
              });
            itemCount++;
          }
        }
        }
        if (!itemPage.hasNextPage() || itemObjects.length === 0) break;
        itemPage = await itemPage.getNextPage();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Error fetching items: ${msg}`);
      console.error('[CatalogSync] Error fetching items:', msg);
    }

    console.log(`[CatalogSync] Synced ${itemCount} catalog items (including variations)`);

    catalogItemCache.clear();
    cacheLoadedAt = 0;

    return { categories: categoryCount, items: itemCount, errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Catalog sync failed: ${msg}`);
    console.error('[CatalogSync] Fatal error:', msg);
    return { categories: categoryCount, items: itemCount, errors };
  }
}

export async function backfillCategories(): Promise<{
  updatedLineItems: number;
  updatedTransactions: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let updatedLineItems = 0;
  let updatedTransactions = 0;

  try {
    console.log('[CatalogBackfill] Starting category backfill...');

    await ensureCacheLoaded();

    const lineItemResult = await db.execute<{
      id: number;
      product_id: string;
      category: string | null;
    }>(sql`
      SELECT id, product_id, category
      FROM order_line_items
      WHERE product_id IS NOT NULL
    `);

    for (const row of lineItemResult.rows) {
      const productId = row.product_id;
      if (!productId) continue;

      const newCategory = catalogItemCache.get(productId);
      if (newCategory && newCategory !== row.category) {
        await db.execute(sql`
          UPDATE order_line_items
          SET category = ${newCategory}
          WHERE id = ${row.id}
        `);
        updatedLineItems++;
      }
    }

    console.log(`[CatalogBackfill] Updated ${updatedLineItems} line items`);

    const txResult = await db.execute<{
      id: number;
      category_id: string;
      square_data: Record<string, unknown> | null;
    }>(sql`
      SELECT id, category_id, square_data
      FROM transactions
    `);

    for (const row of txResult.rows) {
      const squareData =
        typeof row.square_data === 'object' && row.square_data !== null
          ? (row.square_data as Record<string, unknown>)
          : {};
      const orderId = squareData.orderId as string | undefined;
      if (!orderId) continue;

      const orderLineItemsResult = await db.execute<{
        product_id: string | null;
      }>(sql`
        SELECT oli.product_id
        FROM order_line_items oli
        INNER JOIN orders o ON oli.order_id = o.id
        WHERE o.square_id = ${orderId}
        AND oli.product_id IS NOT NULL
        LIMIT 1
      `);

      if (orderLineItemsResult.rows.length > 0) {
        const pid = orderLineItemsResult.rows[0].product_id;
        if (pid) {
          const newCat = catalogItemCache.get(pid);
          if (newCat && newCat !== row.category_id) {
            await db.execute(sql`
              UPDATE transactions
              SET category_id = ${newCat}
              WHERE id = ${row.id}
            `);
            updatedTransactions++;
          }
        }
      }
    }

    console.log(`[CatalogBackfill] Updated ${updatedTransactions} transactions`);

    return { updatedLineItems, updatedTransactions, errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Backfill failed: ${msg}`);
    console.error('[CatalogBackfill] Error:', msg);
    return { updatedLineItems, updatedTransactions, errors };
  }
}
