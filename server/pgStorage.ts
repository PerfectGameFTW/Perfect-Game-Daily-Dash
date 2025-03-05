async getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const startStr = formatEasternDate(start);
    const endStr = formatEasternDate(end);

    console.log('Getting gift card sales for range:', { startStr, endStr });

    // Query total gift card sales using Eastern Time view
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) as total_sales
      FROM gift_cards_et
      WHERE DATE(purchase_date_et) >= ${startStr}::date
        AND DATE(purchase_date_et) <= ${endStr}::date
    `);

    const totalSales = Number(result.rows[0]?.total_sales) || 0;
    console.log('Gift card sales calculated:', totalSales);

    return totalSales;
}
