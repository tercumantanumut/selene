import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/web-scraping/validate
 * Validates a Firecrawl API key by making a test scrape request
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { apiKey } = body;

        if (!apiKey || typeof apiKey !== "string") {
            return NextResponse.json(
                { valid: false, error: "API key is required" },
                { status: 400 }
            );
        }

        // Test the API key with a simple scrape request
        const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                url: "https://example.com",
                formats: ["markdown"],
            }),
        });

        if (response.ok) {
            return NextResponse.json({ valid: true });
        } else {
            const errorData = await response.json().catch(() => ({}));
            return NextResponse.json({
                valid: false,
                error: errorData.error || "Invalid API key",
            });
        }
    } catch (error) {
        console.error("[Firecrawl Validation] Error:", error);
        return NextResponse.json(
            { valid: false, error: "Failed to validate API key" },
            { status: 500 }
        );
    }
}
