
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testMetaMCP() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "meta-ads-mcp-server"],
    env: {
      ...process.env,
      META_ADS_ACCESS_TOKEN: "EAAToawFqH50BRdKTiyseCouP7ALya0ptZBRflUpmWCAoZCtzuZCgkSyqNw9oCZAxpnP4BVXI36NwooDZB6h86jK63KQZAR0FCE97CX6bxVQYtRGPBd5JV3sSuneVbxA5yivPZA67di3ZAbvwUZAM8hJOWSacmgXVzYki8cyYVko6XjmpSQiFuAyEmzwQDoJ4Tu302HwZDZD"
    }
  });

  const client = new Client({
    name: "test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    console.log("Connecting to Meta Ads MCP server...");
    await client.connect(transport);
    
    console.log("Listing tools...");
    const tools = await client.listTools();
    console.log(`Found ${tools.tools.length} tools:`);
    tools.tools.forEach(tool => {
      console.log(`- ${tool.name}: ${tool.description.split('\n')[0]}`);
    });

    // Try to call a simple tool like list_ad_accounts
    if (tools.tools.find(t => t.name === "get_ad_accounts" || t.name === "list_ad_accounts")) {
      const toolName = tools.tools.find(t => t.name === "get_ad_accounts" || t.name === "list_ad_accounts").name;
      console.log(`\nTesting tool: ${toolName}...`);
      const result = await client.callTool({
        name: toolName,
        arguments: {}
      });
      console.log("Result received successfully!");
      // Don't log full result to avoid leaking too much info, but confirm success
    }

  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    process.exit(0);
  }
}

testMetaMCP();
