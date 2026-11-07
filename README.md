# Klipper Printer Dashboard

A web-based dashboard for monitoring multiple Klipper 3D printers with real-time status updates, webcam feeds, and desktop notifications.

## Features

- **Multi-printer monitoring**: Monitor multiple Klipper printers simultaneously
- **Real-time status updates**: Configurable polling interval (default: 1 second)
- **Print progress tracking**: Visual progress bars and ETA calculations
- **Temperature monitoring**: Bed and extruder temperature display
- **Webcam integration**: Live webcam feeds for each printer
- **Desktop notifications**: Automatic notifications when prints complete
- **Responsive design**: Works on desktop and mobile devices
- **Configurable printers**: Add/remove printers dynamically
- **Persistent settings**: Settings saved in browser localStorage
- **CORS-free operation**: Uses Caddy proxy to avoid cross-origin issues

## Quick Start (Docker - Recommended)

1. Clone or download this repository
2. Make sure Docker and Docker Compose are installed
3. Run the following commands:
   ```bash
   docker-compose up -d
   ```
4. Open your browser and navigate to `http://localhost:8080`
5. The dashboard will automatically load with three default printers:
   - Printer 1: `10.0.68.108:4408`
   - Printer 2: `10.0.68.121:4408`
   - Printer 3: `10.0.68.130:4408`

## Alternative Setup (Direct HTML)

1. Download or clone this repository
2. Open `index.html` in a modern web browser
3. **Note**: This method may encounter CORS errors. Use the Docker setup for best results.

## Setup Instructions

### Prerequisites

- Klipper 3D printers with Moonraker API enabled
- Modern web browser (Chrome, Firefox, Safari, Edge)
- Network access to your Klipper printers

### Configuration

1. **Default Printers**: The dashboard comes pre-configured with the printers from your setup. You can modify or remove these as needed.

2. **Adding New Printers**:
   - Click the "Add Printer" button
   - Enter printer name and IP address (e.g., `10.0.68.108:4408`)
   - Optionally add webcam URL (e.g., `http://10.0.68.108:8080/stream`)
   - Click "Add Printer"

3. **Configuring Poll Interval**:
   - Adjust the "Poll Interval" setting in the header
   - Range: 1-60 seconds (default: 1 second)
   - Click "Save" to apply changes

4. **Webcam Setup**:
   - Ensure your printer's webcam is accessible via HTTP
   - Common webcam URLs:
     - `http://[PRINTER_IP]:4408/webcam/?action=stream` (Klipper/Moonraker built-in)
     - `http://[PRINTER_IP]:8080/stream` (mjpg-streamer)
     - `http://[PRINTER_IP]:8080/?action=stream` (mjpg-streamer alternative)

## Browser Compatibility

- **Chrome/Chromium**: Full support including notifications
- **Firefox**: Full support including notifications
- **Safari**: Full support including notifications
- **Edge**: Full support including notifications

## API Endpoints Used

The dashboard communicates with Klipper via the Moonraker API:

- `/server/info` - Basic server and printer information
- `/printer/objects/query?print_stats&heater_bed&extruder&display_status` - Print status and temperatures

## Status Indicators

- **Green (pulsing)**: Printer online and ready
- **Orange (pulsing)**: Currently printing or paused
- **Purple (glowing)**: Print completed
- **Red**: Printer offline

## Notifications

The dashboard will request notification permission on first load. When granted:

- Desktop notifications appear when prints complete
- Notifications include printer name and completion message
- Fallback browser alerts are shown if notifications are disabled

## Docker Deployment

### Building and Running

The recommended way to run this dashboard is using Docker to avoid CORS issues:

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down

# Rebuild after changes
docker-compose up -d --build
```

### Docker Configuration

The application runs on port 8080 by default. You can modify this in `docker-compose.yml`:

```yaml
ports:
  - "3000:80"  # Change 8080 to your preferred port
```

### Docker Troubleshooting

- **Container won't start**: Check Docker logs with `docker-compose logs`
- **Port already in use**: Change the port mapping in `docker-compose.yml`
- **Can't reach printers**: Ensure your Docker host can reach the printer IPs
- **Permission issues**: Try running with `sudo` on Linux systems

## CORS Considerations (Alternative Setup)

If you're not using Docker and encounter CORS errors:

1. **Moonraker Configuration**: Add the following to your `moonraker.conf`:
   ```
   [authorization]
   cors_domains:
       *
   ```

2. **Browser Security**: For local development:
   - Don't open HTML files directly (file:// protocol)
   - Use a local HTTP server instead
   - **Recommended**: Use the Docker setup above

## Troubleshooting

### Printers Show as Offline

1. Check network connectivity to printer IP addresses
2. Verify Klipper/Moonraker is running on the printer
3. Ensure port 4408 is accessible (default Moonraker port)
4. Check browser console for CORS or network errors

### Webcam Not Loading

1. Verify webcam URL is correct and accessible
2. Check if webcam service is running on the printer
3. Ensure webcam is accessible via HTTP (not HTTPS only)
4. Try accessing webcam URL directly in browser

### Notifications Not Working

1. Check if browser notifications are allowed for the site
2. Try refreshing the page to re-request permission
3. Check browser notification settings

### Performance Issues

1. Increase poll interval to reduce server load
2. Disable webcam feeds for printers where not needed
3. Close browser tabs when not actively monitoring

## Development

### File Structure

```
├── index.html      # Main HTML structure
├── styles.css      # CSS styling and responsive design
├── script.js       # JavaScript functionality
└── README.md       # This documentation
```

### Key Components

- **KlipperDashboard Class**: Main application logic
- **Printer Management**: Add/remove/configure printers
- **Status Polling**: Configurable interval API polling
- **Notification System**: Desktop notification handling
- **Responsive UI**: Mobile-friendly interface

## Android App Consideration

While this web application works well on mobile browsers, you mentioned considering an Android app. The current web solution offers several advantages:

- **Cross-platform**: Works on any device with a web browser
- **No installation**: Direct access via browser
- **Easy updates**: Changes deployed instantly
- **Lower maintenance**: Single codebase for all platforms

However, a native Android app could provide:
- Better background processing
- More robust notification handling
- Offline capabilities
- Better system integration

The web dashboard can serve as a solid foundation and prototype for a future Android application.

## License

This project is open source and available under the MIT License.

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Verify your Klipper/Moonraker setup
3. Check browser console for error messages
4. Ensure network connectivity to all printers