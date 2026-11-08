// Test script to verify API endpoint functionality
// Run this in browser console when the dashboard is loaded

// Test print status endpoints (Moonraker objects/query)
async function testPrintStatusEndpoints() {
    const endpoints = [
        '/api/printer1-7125/printer/objects/query?print_stats&heater_bed&extruder&display_status',
        '/api/printer2-7125/printer/objects/query?print_stats&heater_bed&extruder&display_status',
        '/api/printer3-7125/printer/objects/query?print_stats&heater_bed&extruder&display_status'
    ];
    
    console.log('Testing print status endpoints...');
    
    for (const endpoint of endpoints) {
        try {
            console.log(`Testing: ${endpoint}`);
            const response = await fetch(endpoint);
            console.log(`Status: ${response.status}`);
            
            if (response.ok) {
                const data = await response.json();
                console.log(`Success: ${endpoint}`, data);
            } else {
                console.log(`Failed: ${endpoint} - ${response.status}`);
            }
        } catch (error) {
            console.log(`Error: ${endpoint}`, error.message);
        }
        console.log('---');
    }
}

console.log('API test function loaded. Run:');
console.log('testPrintStatusEndpoints() - Test print status endpoints');