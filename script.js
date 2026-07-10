        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  STATE
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        let ws = null;
        let activeView = 'radar';
        let currentMode = 'idle';

        let isEditing = false;

        let waypoints = [];
        let currentTool = 'pan';
        let loopMode = false;
        let waypointRadius = 0.5;

        let radarCanvas = null;
        let radarCtx = null;
        let mapCanvas = null;
        let mapCtx = null;

        let radarWidth = 0;
        let radarHeight = 0;
        let radarCenterX = 0;
        let radarCenterY = 0;
        let radarScale = 96;

        const mapView = {
            zoom: 45,
            centerX: 0,
            centerY: 0,
            dragging: false,
            dragStartX: 0,
            dragStartY: 0,
            dragOriginX: 0,
            dragOriginY: 0,
            // touch pinch
            pinchDist: 0,
            pinchZoom: 45,
        };

        let currentRanges = [];
        let currentAngles = [];
        let maxRange = 12.0;
        let robotX = 0;
        let robotY = 0;
        let robotTheta = 0;
        let currentMap = null;
        let currentPath = [];
        let currentGoal = null;
        let currentCoarseGrid = null;
        let showGridMap = true;

        let lastScanTime = 0;
        let scanCount = 0;
        let scanRate = 0;
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 5;

        // ── helpers ──
        function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  CONFIG
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function updateLinearSpeed() {
            const radius = parseFloat(document.getElementById('wheelRadius').value) || 0.0975;
            const speedRad = parseFloat(document.getElementById('maxSpeedSlider').value) || 0;
            const linear = radius * speedRad;
            document.getElementById('linearSpeedDisplay').textContent = linear.toFixed(2);
        }

        function sendConfig() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const config = {
                wheel_radius: parseFloat(document.getElementById('wheelRadius').value),
                wheel_base: parseFloat(document.getElementById('wheelBase').value),
                lidar_offset_x: parseFloat(document.getElementById('lidarOffsetX').value),
                lidar_offset_y: parseFloat(document.getElementById('lidarOffsetY').value),
                max_speed: parseFloat(document.getElementById('maxSpeedSlider').value),
                robot_width: parseFloat(document.getElementById('robotWidth').value),
                stop_distance: parseFloat(document.getElementById('stopDistance').value)
            };
            ws.send(JSON.stringify({ type: 'set_config', config }));
        }

        function requestConfig() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get_config' }));
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  INIT CANVASES
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function initCanvases() {
            radarCanvas = document.getElementById('radarCanvas');
            radarCtx = radarCanvas.getContext('2d');
            mapCanvas = document.getElementById('mapCanvas');
            mapCtx = mapCanvas.getContext('2d');

            radarWidth = radarCanvas.width;
            radarHeight = radarCanvas.height;
            radarCenterX = radarWidth / 2;
            radarCenterY = radarHeight / 2;

            // Handle resize for canvas scaling
            handleResize();
        }

        function handleResize() {
            // Canvas CSS already handles aspect-ratio; no internal resize needed.
            // But we re-render on resize.
            if (activeView === 'radar') renderRadarView();
            else if (activeView === 'map') renderMapView();
        }

        function getDisplayRange() {
            const radiusPx = Math.min(radarWidth, radarHeight) / 2;
            return radiusPx / radarScale;
        }

        function updateZoomDisplay() {
            const displayRange = getDisplayRange();
            const label = document.getElementById('zoomRange');
            if (label) label.innerHTML = displayRange.toFixed(1) + ' m';
        }

        function setRadarZoom(zoomScale) {
            radarScale = zoomScale;
            document.getElementById('zoomSlider').value = radarScale;
            updateZoomDisplay();
            if (activeView === 'radar') renderRadarView();
        }

        function initZoomSlider() {
            const slider = document.getElementById('zoomSlider');
            slider.addEventListener('input', (e) => setRadarZoom(parseFloat(e.target.value)));

            const mapSlider = document.getElementById('mapZoomSlider');
            if (mapSlider) {
                mapSlider.addEventListener('input', (e) => {
                    const v = parseFloat(e.target.value);
                    mapView.zoom = v;
                    document.getElementById('mapZoomValue').textContent = v.toFixed(0);
                    if (activeView === 'map') renderMapView();
                });
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  VIEWS
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function showView(viewName) {
            activeView = viewName;
            document.getElementById('radarTab').classList.toggle('active', viewName === 'radar');
            document.getElementById('mapTab').classList.toggle('active', viewName === 'map');
            document.getElementById('radarPanel').classList.toggle('active', viewName === 'radar');
            document.getElementById('mapPanel').classList.toggle('active', viewName === 'map');
            // Show/hide mobile D-pad only on map view (more useful there)
            const dpad = document.getElementById('mobileDpad');
            if (viewName === 'map' && currentMode === 'manual') {
                dpad.classList.add('visible');
            } else {
                dpad.classList.remove('visible');
            }
            if (viewName === 'map') renderMapView();
            else renderRadarView();
        }

        // ── radar ──
        function worldToRadarScreen(range, angle) {
            const forward = range * Math.cos(angle);
            const left = range * Math.sin(angle);
            return {
                x: radarCenterX + left * radarScale,
                y: radarCenterY - forward * radarScale,
            };
        }

        function renderRadarBackground() {
            radarCtx.clearRect(0, 0, radarWidth, radarHeight);
            radarCtx.fillStyle = '#0f0f1a';
            radarCtx.fillRect(0, 0, radarWidth, radarHeight);

            radarCtx.strokeStyle = '#2a2a3a';
            radarCtx.lineWidth = 1;

            const displayRange = getDisplayRange();
            const step = 0.5;
            const maxCircle = Math.ceil(displayRange);

            for (let radiusMeters = step; radiusMeters <= maxCircle; radiusMeters += step) {
                const radiusPx = radiusMeters * radarScale;
                if (radiusPx > Math.min(radarWidth, radarHeight) / 2) break;
                radarCtx.beginPath();
                radarCtx.arc(radarCenterX, radarCenterY, radiusPx, 0, 2 * Math.PI);
                radarCtx.stroke();
                radarCtx.fillStyle = '#666';
                radarCtx.font = '10px Arial';
                radarCtx.fillText(radiusMeters.toFixed(1) + 'm', radarCenterX + radiusPx + 3, radarCenterY - 3);
            }

            radarCtx.beginPath();
            radarCtx.strokeStyle = '#3a3a4a';
            radarCtx.moveTo(radarCenterX, 0);
            radarCtx.lineTo(radarCenterX, radarHeight);
            radarCtx.moveTo(0, radarCenterY);
            radarCtx.lineTo(radarWidth, radarCenterY);
            radarCtx.stroke();
        }

        function drawRadarRobot() {
            radarCtx.fillStyle = '#00ff00';
            radarCtx.beginPath();
            radarCtx.arc(radarCenterX, radarCenterY, 8, 0, 2 * Math.PI);
            radarCtx.fill();

            radarCtx.beginPath();
            radarCtx.moveTo(radarCenterX, radarCenterY - 14);
            radarCtx.lineTo(radarCenterX - 6, radarCenterY + 3);
            radarCtx.lineTo(radarCenterX + 6, radarCenterY + 3);
            radarCtx.closePath();
            radarCtx.fill();

            radarCtx.strokeStyle = '#00ff00';
            radarCtx.lineWidth = 2;
            radarCtx.strokeRect(radarCenterX - 10, radarCenterY - 15, 20, 30);

            radarCtx.fillStyle = '#00ff00';
            radarCtx.font = 'bold 12px Arial';
            radarCtx.fillText('ROBOT', radarCenterX - 20, radarCenterY - 18);

            radarCtx.fillStyle = '#aaaaaa';
            radarCtx.font = '10px Arial';
            radarCtx.fillText(`heading: ${(robotTheta * 180 / Math.PI).toFixed(0)}°`, radarCenterX - 38, radarCenterY + 26);
        }

        function drawRadarPoints(ranges, angles) {
            if (!ranges || !angles) return;
            const displayRange = getDisplayRange();
            for (let i = 0; i < ranges.length; i++) {
                const range = ranges[i];
                const angle = angles[i];
                if (range >= maxRange || range <= 0.1 || range > displayRange) continue;
                const screen = worldToRadarScreen(range, angle);
                if (screen.x >= 0 && screen.x < radarWidth && screen.y >= 0 && screen.y < radarHeight) {
                    const t = Math.min(1, range / maxRange);
                    const red = 255;
                    const green = Math.floor(255 * t);
                    const blue = Math.floor(100 * (1 - t));
                    radarCtx.fillStyle = `rgb(${red},${green},${blue})`;
                    radarCtx.fillRect(screen.x - 1.5, screen.y - 1.5, 3, 3);
                }
            }
        }

        function renderRadarView() {
            renderRadarBackground();
            drawRadarPoints(currentRanges, currentAngles);
            drawRadarRobot();
        }

        // ── map ──
        function worldToMapScreen(worldX, worldY) {
            return {
                x: mapCanvas.width / 2 + (worldX - mapView.centerX) * mapView.zoom,
                y: mapCanvas.height / 2 + (worldY - mapView.centerY) * mapView.zoom,
            };
        }

        function mapScreenToWorld(screenX, screenY) {
            return {
                x: mapView.centerX + (screenX - mapCanvas.width / 2) / mapView.zoom,
                y: mapView.centerY + (screenY - mapCanvas.height / 2) / mapView.zoom,
            };
        }

        function resetMapView() {
            mapView.zoom = 45;
            mapView.centerX = 0;
            mapView.centerY = 0;
            if (activeView === 'map') renderMapView();
        }

        function centerMapOnRobot() {
            mapView.centerX = robotX;
            mapView.centerY = robotY;
            if (activeView === 'map') renderMapView();
        }

        function toggleGridMap() {
            showGridMap = !showGridMap;
            document.getElementById('toggleGridBtn').textContent = showGridMap ? 'Hide Grid' : 'Show Grid';
            if (activeView === 'map') renderMapView();
        }

        function drawCoarseGrid(coarseGridData) {
            if (!coarseGridData || !coarseGridData.data || !showGridMap) return;
            const mapWidth = coarseGridData.width;
            const mapHeight = coarseGridData.height;
            const resolution = coarseGridData.resolution;
            const originX = coarseGridData.origin_x || -mapWidth * resolution / 2;
            const originY = coarseGridData.origin_y || -mapHeight * resolution / 2;
            const cellSize = resolution * mapView.zoom;
            const step = cellSize < 1.0 ? 2 : 1;

            const visibleWorldWidth = mapCanvas.width / mapView.zoom;
            const visibleWorldHeight = mapCanvas.height / mapView.zoom;
            const leftWorld = mapView.centerX - visibleWorldWidth / 2 - resolution * step;
            const rightWorld = mapView.centerX + visibleWorldWidth / 2 + resolution * step;
            const bottomWorld = mapView.centerY - visibleWorldHeight / 2 - resolution * step;
            const topWorld = mapView.centerY + visibleWorldHeight / 2 + resolution * step;

            const gxStart = Math.max(0, Math.floor((leftWorld - originX) / resolution));
            const gxEnd = Math.min(mapWidth - 1, Math.ceil((rightWorld - originX) / resolution));
            const gyStart = Math.max(0, Math.floor((bottomWorld - originY) / resolution));
            const gyEnd = Math.min(mapHeight - 1, Math.ceil((topWorld - originY) / resolution));

            for (let gy = gyStart; gy <= gyEnd; gy += step) {
                for (let gx = gxStart; gx <= gxEnd; gx += step) {
                    const value = coarseGridData.data[gy * mapWidth + gx];
                    if (value !== 1) continue;
                    const worldX = originX + gx * resolution;
                    const worldY = originY + gy * resolution;
                    const screen = worldToMapScreen(worldX, worldY);
                    const size = cellSize * step;
                    if (screen.x + size < 0 || screen.x > mapCanvas.width ||
                        screen.y + size < 0 || screen.y > mapCanvas.height) continue;
                    mapCtx.fillStyle = 'rgba(255, 200, 0, 0.3)';
                    mapCtx.strokeStyle = 'rgba(255, 200, 0, 0.5)';
                    mapCtx.lineWidth = 0.5;
                    mapCtx.fillRect(screen.x, screen.y, size, size);
                    mapCtx.strokeRect(screen.x, screen.y, size, size);
                }
            }
        }

        function niceStep(range, targetTicks = 6) {
            const rough = range / targetTicks;
            const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
            const normalized = rough / magnitude;
            let nice;
            if (normalized < 1.5) nice = 1;
            else if (normalized < 3.5) nice = 2;
            else if (normalized < 7.5) nice = 5;
            else nice = 10;
            return nice * magnitude;
        }

        function drawMapAxes() {
            const canvasWidth = mapCanvas.width;
            const canvasHeight = mapCanvas.height;
            const visibleWorldWidth = canvasWidth / mapView.zoom;
            const visibleWorldHeight = canvasHeight / mapView.zoom;
            const leftWorld = mapView.centerX - visibleWorldWidth / 2;
            const rightWorld = mapView.centerX + visibleWorldWidth / 2;
            const bottomWorld = mapView.centerY - visibleWorldHeight / 2;
            const topWorld = mapView.centerY + visibleWorldHeight / 2;

            const stepx = niceStep(visibleWorldWidth, 12);
            const stepy = niceStep(visibleWorldHeight, 15);

            const originScreen = worldToMapScreen(0, 0);
            const originVisible = (leftWorld <= 0 && rightWorld >= 0 && bottomWorld <= 0 && topWorld >= 0);

            mapCtx.strokeStyle = 'rgba(100,100,150,0.4)';
            mapCtx.lineWidth = 1.5;

            if (leftWorld <= 0 && rightWorld >= 0) {
                mapCtx.beginPath();
                mapCtx.moveTo(originScreen.x, 0);
                mapCtx.lineTo(originScreen.x, canvasHeight);
                mapCtx.stroke();
                mapCtx.fillStyle = '#555';
                mapCtx.font = 'bold 12px Arial';
                mapCtx.textAlign = 'left';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillText('Y', originScreen.x + 6, 18);
            }
            if (bottomWorld <= 0 && topWorld >= 0) {
                mapCtx.beginPath();
                mapCtx.moveTo(0, originScreen.y);
                mapCtx.lineTo(canvasWidth, originScreen.y);
                mapCtx.stroke();
                mapCtx.fillStyle = '#555';
                mapCtx.font = 'bold 12px Arial';
                mapCtx.textAlign = 'right';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillText('X', canvasWidth - 8, originScreen.y - 4);
            }

            const xPosForYLabels = leftWorld;
            const yStart = Math.ceil(bottomWorld / stepy) * stepy;
            const yEnd = Math.floor(topWorld / stepy) * stepy;
            if (yStart <= yEnd) {
                for (let y = yStart; y <= yEnd; y += stepy) {
                    if (Math.abs(y) < 0.001) continue;
                    const s = worldToMapScreen(xPosForYLabels, y);
                    if (s.y >= 0 && s.y <= canvasHeight) {
                        mapCtx.strokeStyle = 'rgba(80,80,120,0.3)';
                        mapCtx.lineWidth = 1;
                        mapCtx.beginPath();
                        mapCtx.moveTo(0, s.y);
                        mapCtx.lineTo(6, s.y);
                        mapCtx.stroke();
                        mapCtx.fillStyle = '#666';
                        mapCtx.textAlign = 'left';
                        mapCtx.textBaseline = 'middle';
                        mapCtx.fillText(y.toFixed(1), 10, s.y);
                    }
                }
            }

            const yPosForXLabelsTop = topWorld;
            const xStart = Math.ceil(leftWorld / stepx) * stepx;
            const xEnd = Math.floor(rightWorld / stepx) * stepx;
            if (xStart <= xEnd) {
                for (let x = xStart; x <= xEnd; x += stepx) {
                    if (Math.abs(x) < 0.001) continue;
                    const s = worldToMapScreen(x, yPosForXLabelsTop);
                    if (s.x >= 0 && s.x <= canvasWidth) {
                        mapCtx.strokeStyle = 'rgba(80,80,120,0.3)';
                        mapCtx.lineWidth = 1;
                        mapCtx.beginPath();
                        mapCtx.moveTo(s.x, 0);
                        mapCtx.lineTo(s.x, 6);
                        mapCtx.stroke();
                        mapCtx.fillStyle = '#666';
                        mapCtx.textAlign = 'center';
                        mapCtx.textBaseline = 'top';
                        mapCtx.fillText(x.toFixed(1), s.x, 10);
                    }
                }
            }

            if (originVisible) {
                mapCtx.textAlign = 'left';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillStyle = '#888';
                mapCtx.font = '10px Arial';
                mapCtx.fillText('0', originScreen.x + 4, originScreen.y - 4);
            }

            mapCtx.fillStyle = 'rgba(100,100,150,0.5)';
            if (bottomWorld <= 0 && topWorld >= 0) {
                const rightEdgeX = worldToMapScreen(rightWorld - 0.1, 0);
                if (rightEdgeX.x < canvasWidth - 20) {
                    mapCtx.beginPath();
                    mapCtx.moveTo(rightEdgeX.x + 10, rightEdgeX.y);
                    mapCtx.lineTo(rightEdgeX.x + 2, rightEdgeX.y - 5);
                    mapCtx.lineTo(rightEdgeX.x + 2, rightEdgeX.y + 5);
                    mapCtx.closePath();
                    mapCtx.fill();
                }
            }
            if (leftWorld <= 0 && rightWorld >= 0) {
                const topEdgeY = worldToMapScreen(0, topWorld - 0.1);
                if (topEdgeY.y > 20) {
                    mapCtx.beginPath();
                    mapCtx.moveTo(topEdgeY.x, topEdgeY.y - 10);
                    mapCtx.lineTo(topEdgeY.x - 5, topEdgeY.y - 2);
                    mapCtx.lineTo(topEdgeY.x + 5, topEdgeY.y - 2);
                    mapCtx.closePath();
                    mapCtx.fill();
                }
            }
        }

        function drawMapCells(mapData) {
            if (!mapData || !mapData.data) return;
            const mapWidth = mapData.width;
            const mapHeight = mapData.height;
            const resolution = mapData.resolution;
            const mapOriginX = -mapWidth * resolution / 2;
            const mapOriginY = -mapHeight * resolution / 2;
            const cellSize = resolution * mapView.zoom;

            const visibleWorldWidth = mapCanvas.width / mapView.zoom;
            const visibleWorldHeight = mapCanvas.height / mapView.zoom;
            const leftWorld = mapView.centerX - visibleWorldWidth / 2 - resolution;
            const rightWorld = mapView.centerX + visibleWorldWidth / 2 + resolution;
            const bottomWorld = mapView.centerY - visibleWorldHeight / 2 - resolution;
            const topWorld = mapView.centerY + visibleWorldHeight / 2 + resolution;

            const gxStart = Math.max(0, Math.floor((leftWorld - mapOriginX) / resolution));
            const gxEnd = Math.min(mapWidth - 1, Math.ceil((rightWorld - mapOriginX) / resolution));
            const gyStart = Math.max(0, Math.floor((bottomWorld - mapOriginY) / resolution));
            const gyEnd = Math.min(mapHeight - 1, Math.ceil((topWorld - mapOriginY) / resolution));

            const drawStep = cellSize < 0.5 ? 4 : 1;

            for (let gy = gyStart; gy <= gyEnd; gy += drawStep) {
                for (let gx = gxStart; gx <= gxEnd; gx += drawStep) {
                    const value = mapData.data[gy * mapWidth + gx];
                    if (value < 0) continue;
                    const worldX = mapOriginX + gx * resolution;
                    const worldY = mapOriginY + gy * resolution;
                    const screen = worldToMapScreen(worldX, worldY);
                    const size = cellSize * drawStep;
                    if (screen.x + size < 0 || screen.x > mapCanvas.width ||
                        screen.y + size < 0 || screen.y > mapCanvas.height) continue;
                    mapCtx.fillStyle = value >= 30 ? 'rgba(255,68,68,0.85)' : 'rgba(101,181,255,0.12)';
                    mapCtx.fillRect(screen.x, screen.y, size, size);
                }
            }
        }

        function drawRobotOnMap() {
            const screen = worldToMapScreen(robotX, robotY);
            const heading = robotTheta;
            const forwardX = Math.cos(heading);
            const forwardY = Math.sin(heading);
            const leftX = -Math.sin(heading);
            const leftY = Math.cos(heading);
            const robotSize = 0.18;
            const nose = {
                x: screen.x + forwardX * robotSize * mapView.zoom,
                y: screen.y - forwardY * robotSize * mapView.zoom,
            };
            const leftPoint = {
                x: screen.x - forwardX * robotSize * 0.6 * mapView.zoom + leftX * robotSize * 0.7 * mapView.zoom,
                y: screen.y + forwardY * robotSize * 0.6 * mapView.zoom - leftY * robotSize * 0.7 * mapView.zoom,
            };
            const rightPoint = {
                x: screen.x - forwardX * robotSize * 0.6 * mapView.zoom - leftX * robotSize * 0.7 * mapView.zoom,
                y: screen.y + forwardY * robotSize * 0.6 * mapView.zoom + leftY * robotSize * 0.7 * mapView.zoom,
            };

            mapCtx.fillStyle = '#00ff88';
            mapCtx.beginPath();
            mapCtx.arc(screen.x, screen.y, 6, 0, 2 * Math.PI);
            mapCtx.fill();

            mapCtx.strokeStyle = '#00ff88';
            mapCtx.lineWidth = 2;
            mapCtx.beginPath();
            mapCtx.moveTo(screen.x, screen.y);
            mapCtx.lineTo(nose.x, nose.y);
            mapCtx.stroke();

            mapCtx.fillStyle = '#00ff88';
            mapCtx.beginPath();
            mapCtx.moveTo(nose.x, nose.y);
            mapCtx.lineTo(leftPoint.x, leftPoint.y);
            mapCtx.lineTo(rightPoint.x, rightPoint.y);
            mapCtx.closePath();
            mapCtx.fill();
        }

        function drawPath(path) {
            if (currentGoal) {
                const gs = worldToMapScreen(currentGoal.x, currentGoal.y);
                const pulseRadius = 10 + 4 * Math.sin(Date.now() / 500);
                const grad = mapCtx.createRadialGradient(gs.x, gs.y, 0, gs.x, gs.y, 20);
                grad.addColorStop(0, 'rgba(255,0,0,0.6)');
                grad.addColorStop(0.5, 'rgba(255,0,0,0.2)');
                grad.addColorStop(1, 'rgba(255,0,0,0)');
                mapCtx.fillStyle = grad;
                mapCtx.beginPath();
                mapCtx.arc(gs.x, gs.y, 20, 0, 2 * Math.PI);
                mapCtx.fill();

                mapCtx.fillStyle = '#ff0000';
                mapCtx.beginPath();
                mapCtx.arc(gs.x, gs.y, 6, 0, 2 * Math.PI);
                mapCtx.fill();

                mapCtx.strokeStyle = '#ff4444';
                mapCtx.lineWidth = 2;
                mapCtx.beginPath();
                mapCtx.arc(gs.x, gs.y, 8, 0, 2 * Math.PI);
                mapCtx.stroke();

                mapCtx.fillStyle = '#ff0000';
                mapCtx.font = 'bold 11px Arial';
                mapCtx.textAlign = 'left';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillText('🎯 GOAL', gs.x + 12, gs.y - 4);
                mapCtx.fillStyle = '#cc0000';
                mapCtx.font = '9px Arial';
                mapCtx.textAlign = 'left';
                mapCtx.textBaseline = 'top';
                mapCtx.fillText(`(${currentGoal.x.toFixed(2)}, ${currentGoal.y.toFixed(2)})`, gs.x + 12, gs.y + 4);
            }

            if (!path || path.length === 0) return;

            const robotScreen = worldToMapScreen(robotX, robotY);
            const firstPoint = path[0];
            const firstScreen = worldToMapScreen(firstPoint.x, firstPoint.y);
            const dx = firstPoint.x - robotX;
            const dy = firstPoint.y - robotY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0.1) {
                mapCtx.setLineDash([6, 6]);
                mapCtx.strokeStyle = 'rgba(255,136,0,0.4)';
                mapCtx.lineWidth = 1.5;
                mapCtx.beginPath();
                mapCtx.moveTo(robotScreen.x, robotScreen.y);
                mapCtx.lineTo(firstScreen.x, firstScreen.y);
                mapCtx.stroke();
                mapCtx.setLineDash([]);

                const midX = (robotScreen.x + firstScreen.x) / 2;
                const midY = (robotScreen.y + firstScreen.y) / 2;
                const distText = dist.toFixed(2) + 'm';
                mapCtx.fillStyle = 'rgba(244,247,251,0.8)';
                const metrics = mapCtx.measureText(distText);
                const pad = 4;
                mapCtx.fillRect(midX - metrics.width / 2 - pad, midY - 16 - pad, metrics.width + pad * 2, 16 + pad * 2);
                mapCtx.fillStyle = 'rgba(255,136,0,0.8)';
                mapCtx.font = '9px Arial';
                mapCtx.textAlign = 'center';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillText(distText, midX, midY - 4);
            }

            mapCtx.strokeStyle = '#ff8800';
            mapCtx.lineWidth = 2.5;
            mapCtx.setLineDash([]);
            mapCtx.beginPath();
            for (let i = 0; i < path.length; i++) {
                const s = worldToMapScreen(path[i].x, path[i].y);
                if (i === 0) mapCtx.moveTo(s.x, s.y);
                else mapCtx.lineTo(s.x, s.y);
            }
            mapCtx.stroke();

            for (let i = 0; i < path.length; i++) {
                const s = worldToMapScreen(path[i].x, path[i].y);
                const color = (i === 0) ? '#ff8800' : (i === path.length - 1 ? '#ff4400' : '#ffaa44');
                const size = (i === 0 || i === path.length - 1) ? 5 : 3;
                mapCtx.fillStyle = 'rgba(255,136,0,0.15)';
                mapCtx.beginPath();
                mapCtx.arc(s.x, s.y, size + 6, 0, 2 * Math.PI);
                mapCtx.fill();
                mapCtx.fillStyle = color;
                mapCtx.beginPath();
                mapCtx.arc(s.x, s.y, size, 0, 2 * Math.PI);
                mapCtx.fill();
                if (path.length <= 20) {
                    mapCtx.fillStyle = 'rgba(0,0,0,0.6)';
                    mapCtx.font = '8px Arial';
                    mapCtx.textAlign = 'center';
                    mapCtx.textBaseline = 'bottom';
                    mapCtx.fillText((i + 1).toString(), s.x, s.y - size - 4);
                }
            }

            let totalDist = 0;
            for (let i = 1; i < path.length; i++) {
                const dx = path[i].x - path[i - 1].x;
                const dy = path[i].y - path[i - 1].y;
                totalDist += Math.sqrt(dx * dx + dy * dy);
            }
            if (path.length > 1 && totalDist > 0.1) {
                const last = path[path.length - 1];
                const ls = worldToMapScreen(last.x, last.y);
                const label = '📏 ' + totalDist.toFixed(2) + 'm';
                mapCtx.fillStyle = 'rgba(244,247,251,0.85)';
                const metrics = mapCtx.measureText(label);
                const pad = 6;
                mapCtx.fillRect(ls.x - metrics.width / 2 - pad, ls.y + 12 - pad, metrics.width + pad * 2, 20 + pad * 2);
                mapCtx.fillStyle = '#cc6600';
                mapCtx.font = '10px Arial';
                mapCtx.textAlign = 'center';
                mapCtx.textBaseline = 'top';
                mapCtx.fillText(label, ls.x, ls.y + 14);
            }
        }

        function drawWaypoints() {
            if (!waypoints || waypoints.length === 0) return;
            for (let i = 0; i < waypoints.length; i++) {
                const wp = waypoints[i];
                const s = worldToMapScreen(wp.x, wp.y);
                mapCtx.fillStyle = '#ffcc00';
                mapCtx.shadowColor = 'rgba(255,204,0,0.5)';
                mapCtx.shadowBlur = 12;
                mapCtx.beginPath();
                mapCtx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
                mapCtx.fill();
                mapCtx.shadowBlur = 0;
                mapCtx.fillStyle = '#1f2937';
                mapCtx.font = 'bold 11px Arial';
                mapCtx.textAlign = 'center';
                mapCtx.textBaseline = 'middle';
                mapCtx.fillText((i + 1).toString(), s.x, s.y);
                mapCtx.fillStyle = '#1f2937';
                mapCtx.font = '10px Arial';
                mapCtx.textAlign = 'left';
                mapCtx.textBaseline = 'bottom';
                mapCtx.fillText(`(${wp.x.toFixed(2)}, ${wp.y.toFixed(2)})`, s.x + 10, s.y - 2);
            }
        }

        function renderMapView() {
            mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
            mapCtx.fillStyle = '#f4f7fb';
            mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

            drawMapAxes();
            if (currentMap) drawMapCells(currentMap);
            drawCoarseGrid(currentCoarseGrid);
            drawRobotOnMap();
            drawPath(currentPath);
            drawWaypoints();

            mapCtx.fillStyle = '#1f2937';
            mapCtx.font = '12px Arial';
            mapCtx.fillText(`zoom: ${mapView.zoom.toFixed(0)} px/m`, 12, 18);
            mapCtx.fillText(`pose: (${robotX.toFixed(2)}, ${robotY.toFixed(2)})`, 12, 34);
            mapCtx.fillStyle = '#666';
            mapCtx.font = '10px Arial';
            mapCtx.fillText(`Grid: ${showGridMap ? 'ON' : 'OFF'}`, 12, 52);
        }

        function renderActiveView() {
            if (activeView === 'map') renderMapView();
            else renderRadarView();
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  MODE
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function setMode(mode, silent = false) {
            if (mode === currentMode) return;
            currentMode = mode;

            document.querySelectorAll('.mode-btn').forEach((btn) => {
                const isActive = btn.dataset.mode === mode;
                btn.classList.toggle('active', isActive);
            });

            const hint = document.getElementById('keyboardHint');
            if (mode === 'manual') {
                hint.classList.add('visible');
            } else {
                hint.classList.remove('visible');
            }

            // Show/hide mobile D-pad
            const dpad = document.getElementById('mobileDpad');
            if (mode === 'manual' && activeView === 'map') {
                dpad.classList.add('visible');
            } else {
                dpad.classList.remove('visible');
            }

            const modeLabels = { idle: 'Idle', manual: 'Manual', auto: 'Auto' };
            document.getElementById('robotMode').innerHTML = modeLabels[mode] || mode;

            if (silent) return;

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.warn('[Mode] Not connected - local only');
                return;
            }

            switch (mode) {
                case 'idle':
                    sendCommand('stop');
                    break;
                case 'manual':
                    ws.send(JSON.stringify({ type: 'autonomy', auto_navigate: false }));
                    break;
                case 'auto':
                    sendCommand('auto');
                    break;
                default:
                    break;
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  NETWORK
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function updateScanRate(currentTime) {
            if (lastScanTime > 0) {
                const delta = currentTime - lastScanTime;
                if (delta > 0) {
                    const instantRate = 1.0 / delta;
                    scanRate = scanRate * 0.8 + instantRate * 0.2;
                    document.getElementById('scanRate').innerHTML = scanRate.toFixed(1) + ' Hz';
                }
            }
            lastScanTime = currentTime;
            scanCount++;
        }

        function handleRobotMessage(data) {
            if (data.type === 'lidar_scan') {
                currentRanges = data.ranges || [];
                currentAngles = data.angles || [];
                maxRange = data.max_range !== undefined ? data.max_range : maxRange;

                robotX = data.robot_x !== undefined ? data.robot_x : 0;
                robotY = data.robot_y !== undefined ? data.robot_y : 0;
                robotTheta = data.robot_theta !== undefined ? data.robot_theta : 0;

                const leftSpeed = data.left_speed !== undefined ? data.left_speed : 0;
                const rightSpeed = data.right_speed !== undefined ? data.right_speed : 0;
                const linearVel = data.linear_vel !== undefined ? data.linear_vel : 0;

                updateScanRate(data.timestamp || 0);

                document.getElementById('numPoints').innerHTML = (data.num_points || 0).toLocaleString();
                document.getElementById('rangeLimit').innerHTML =
                    `${(data.min_range || 0).toFixed(1)}-${(data.max_range || 0).toFixed(1)} m`;
                document.getElementById('lastScan').innerHTML = (data.timestamp || 0).toFixed(2) + ' s';
                document.getElementById('leftSpeed').innerHTML = leftSpeed.toFixed(2) + ' m/s';
                document.getElementById('rightSpeed').innerHTML = rightSpeed.toFixed(2) + ' m/s';
                document.getElementById('posX').innerHTML = robotX.toFixed(2) + ' m';
                document.getElementById('posY').innerHTML = robotY.toFixed(2) + ' m';
                document.getElementById('theta').innerHTML = (robotTheta * 180 / Math.PI).toFixed(1) + ' °';
                document.getElementById('linearVel').innerHTML = linearVel.toFixed(2) + ' m/s';

                if (data.auto_navigate !== undefined) {
                    const serverMode = data.auto_navigate ? 'auto' : 'manual';
                    if (serverMode !== currentMode) {
                        if (serverMode === 'auto') {
                            setMode('auto', true);
                        } else if (serverMode === 'manual' && currentMode !== 'idle') {
                            setMode('manual', true);
                        }
                    }
                }

                if (data.map) currentMap = data.map;
                if (data.coarse_grid) currentCoarseGrid = data.coarse_grid;
                if (data.path) currentPath = data.path.map(p => ({ x: p.x, y: p.y }));
                else currentPath = [];
                if (data.goal) currentGoal = { x: data.goal.x, y: data.goal.y };

                renderActiveView();
            } else if (data.type === 'robot_info') {
                document.getElementById('leftSpeed').innerHTML = (data.left_speed || 0).toFixed(2) + ' m/s';
                document.getElementById('rightSpeed').innerHTML = (data.right_speed || 0).toFixed(2) + ' m/s';
                document.getElementById('posX').innerHTML = (data.x || 0).toFixed(2) + ' m';
                document.getElementById('posY').innerHTML = (data.y || 0).toFixed(2) + ' m';
                document.getElementById('theta').innerHTML = ((data.theta || 0) * 180 / Math.PI).toFixed(1) + ' °';
                document.getElementById('linearVel').innerHTML = (data.linear_vel || 0).toFixed(2) + ' m/s';

                if (data.auto_navigate !== undefined) {
                    const serverMode = data.auto_navigate ? 'auto' : 'manual';
                    if (serverMode !== currentMode) {
                        if (serverMode === 'auto') {
                            setMode('auto', true);
                        } else if (serverMode === 'manual' && currentMode !== 'idle') {
                            setMode('manual', true);
                        }
                    }
                }
            } else if (data.type === 'registered') {
                document.getElementById('connectionStatus').className = 'status connected';
                document.getElementById('connectionStatus').innerHTML = `Registered (${data.bridge_status || 'online'})`;
                requestConfig();
                return;
            } else if (data.remaining_waypoints !== undefined) {
                waypoints = data.remaining_waypoints.map(wp => ({ x: wp.x, y: wp.y }));
                updateWaypointUI();
                if (activeView === 'map') renderMapView();
            }
        }

        function connectWebSocket() {
            const relayUrl = document.getElementById('wsUrl').value;
            const bridgeId = document.getElementById('bridgeId').value;

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }

            ws = new WebSocket(relayUrl);

            ws.onopen = function() {
                ws.send(JSON.stringify({
                    type: 'register',
                    role: 'browser',
                    bridgeId: bridgeId,
                    token: 'kmo-bridge-token1'
                }));
                scanCount = 0;
                scanRate = 0;
                reconnectAttempts = 0;
            };

            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'bridge_ready') {
                        document.getElementById('connectionStatus').className = 'status connected';
                        document.getElementById('connectionStatus').innerHTML = 'Connected (Relay)';
                        return;
                    }
                    if (data.type === 'bridge_offline') {
                        document.getElementById('connectionStatus').className = 'status disconnected';
                        document.getElementById('connectionStatus').innerHTML = 'Bridge Offline';
                        return;
                    }
                    if (data.type === 'bridge_online') {
                        document.getElementById('connectionStatus').className = 'status connected';
                        document.getElementById('connectionStatus').innerHTML = 'Bridge Online';
                        return;
                    }
                    if (data.type === 'error') {
                        document.getElementById('connectionStatus').className = 'status error';
                        document.getElementById('connectionStatus').innerHTML = 'Error';
                        return;
                    }
                    if (data.type === 'config' || data.type === 'config_updated') {
                        if (isEditing) return;
                        const c = data.config;
                        if (c.wheel_radius !== undefined) document.getElementById('wheelRadius').value = c.wheel_radius;
                        if (c.wheel_base !== undefined) document.getElementById('wheelBase').value = c.wheel_base;
                        if (c.lidar_offset_x !== undefined) document.getElementById('lidarOffsetX').value = c.lidar_offset_x;
                        if (c.lidar_offset_y !== undefined) document.getElementById('lidarOffsetY').value = c.lidar_offset_y;
                        if (c.max_speed !== undefined) {
                            document.getElementById('maxSpeedSlider').value = c.max_speed;
                            document.getElementById('maxSpeedDisplay').textContent = c.max_speed.toFixed(1);
                        }
                        if (c.robot_width !== undefined) document.getElementById('robotWidth').value = c.robot_width;
                        if (c.stop_distance !== undefined) document.getElementById('stopDistance').value = c.stop_distance;
                        updateLinearSpeed();
                        return;
                    }

                    handleRobotMessage(data);

                } catch (error) {
                    console.error('[WebSocket] Parse error:', error);
                }
            };

            ws.onerror = function(error) {
                console.error('[WebSocket] Error:', error);
                document.getElementById('connectionStatus').className = 'status error';
                document.getElementById('connectionStatus').innerHTML = 'Error';
            };

            ws.onclose = function(event) {
                document.getElementById('connectionStatus').className = 'status disconnected';
                document.getElementById('connectionStatus').innerHTML = 'Disconnected';

                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    setTimeout(() => connectWebSocket(), 3000);
                }
            };
        }

        function disconnectWebSocket() {
            if (ws) {
                ws.close();
                ws = null;
            }
        }

        function sendCommand(command) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.warn('[Command] Not connected');
                return;
            }
            ws.send(JSON.stringify({ type: 'command', command: command }));
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  KEYBOARD
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function setupKeyboardControls() {
            document.addEventListener('keydown', function(event) {
                if (event.key === 'q' || event.key === 'Q') {
                    if (currentMode === 'manual') {
                        setMode('idle');
                        sendCommand('stop');
                    }
                    event.preventDefault();
                    return;
                }

                if (currentMode !== 'manual') return;

                switch (event.key) {
                    case 'ArrowUp':
                        sendCommand('forward');
                        event.preventDefault();
                        break;
                    case 'ArrowDown':
                        sendCommand('backward');
                        event.preventDefault();
                        break;
                    case 'ArrowLeft':
                        sendCommand('left');
                        event.preventDefault();
                        break;
                    case 'ArrowRight':
                        sendCommand('right');
                        event.preventDefault();
                        break;
                    case ' ':
                        sendCommand('stop');
                        event.preventDefault();
                        break;
                    case 'a':
                    case 'A':
                        setMode('auto');
                        event.preventDefault();
                        break;
                    case 'm':
                    case 'M':
                        showView('map');
                        event.preventDefault();
                        break;
                    case 'r':
                    case 'R':
                        showView('radar');
                        event.preventDefault();
                        break;
                    default:
                        break;
                }
            });
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  MAP INTERACTIONS (mouse + touch)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function getCanvasCoords(e) {
            const rect = mapCanvas.getBoundingClientRect();
            const scaleX = mapCanvas.width / rect.width;
            const scaleY = mapCanvas.height / rect.height;
            let clientX, clientY;
            if (e.touches) {
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            } else {
                clientX = e.clientX;
                clientY = e.clientY;
            }
            return {
                x: (clientX - rect.left) * scaleX,
                y: (clientY - rect.top) * scaleY,
            };
        }

        function getTouchDist(e) {
            if (e.touches.length < 2) return 0;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function setupMapInteractions() {
            // --- Tool buttons ---
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');
                    currentTool = this.dataset.tool;
                    mapCanvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
                });
                // touch support
                btn.addEventListener('touchstart', function(e) {
                    // Just trigger the click, but prevent double-firing
                }, { passive: true });
            });

            document.getElementById('loopCheckbox').addEventListener('change', function() {
                loopMode = this.checked;
            });

            // ── Mouse events ──
            mapCanvas.addEventListener('mousedown', function(event) {
                if (activeView !== 'map') return;
                if (currentTool === 'pan') {
                    mapView.dragging = true;
                    mapView.dragStartX = event.clientX;
                    mapView.dragStartY = event.clientY;
                    mapView.dragOriginX = mapView.centerX;
                    mapView.dragOriginY = mapView.centerY;
                } else {
                    const coords = getCanvasCoords(event);
                    const world = mapScreenToWorld(coords.x, coords.y);
                    if (currentTool === 'add') {
                        addWaypoint(world.x, world.y);
                    } else if (currentTool === 'remove') {
                        removeWaypoint(world.x, world.y);
                    }
                }
            });

            window.addEventListener('mousemove', function(event) {
                if (!mapView.dragging) return;
                const deltaX = event.clientX - mapView.dragStartX;
                const deltaY = event.clientY - mapView.dragStartY;
                mapView.centerX = mapView.dragOriginX - deltaX / mapView.zoom;
                mapView.centerY = mapView.dragOriginY - deltaY / mapView.zoom;
                if (activeView === 'map') renderMapView();
            });

            window.addEventListener('mouseup', function() {
                mapView.dragging = false;
            });

            mapCanvas.addEventListener('wheel', function(event) {
                if (activeView !== 'map') return;
                event.preventDefault();
                const rect = mapCanvas.getBoundingClientRect();
                const scaleX = mapCanvas.width / rect.width;
                const scaleY = mapCanvas.height / rect.height;
                const mouseX = (event.clientX - rect.left) * scaleX;
                const mouseY = (event.clientY - rect.top) * scaleY;
                const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
                const mouseWorld = mapScreenToWorld(mouseX, mouseY);
                mapView.zoom = clamp(mapView.zoom * zoomFactor, 10, 180);
                mapView.centerX = mouseWorld.x - (mouseX - mapCanvas.width / 2) / mapView.zoom;
                mapView.centerY = mouseWorld.y - (mouseY - mapCanvas.height / 2) / mapView.zoom;
                document.getElementById('mapZoomSlider').value = mapView.zoom;
                document.getElementById('mapZoomValue').textContent = mapView.zoom.toFixed(0);
                if (activeView === 'map') renderMapView();
            }, { passive: false });

            // ── Touch events ──
            let touchStartTime = 0;
            let touchStartPos = null;
            let touchPanStartX = 0;
            let touchPanStartY = 0;
            let touchPanOriginX = 0;
            let touchPanOriginY = 0;
            let isPinching = false;
            let pinchStartDist = 0;
            let pinchStartZoom = 45;

            mapCanvas.addEventListener('touchstart', function(event) {
                if (activeView !== 'map') return;
                const touches = event.touches;

                if (touches.length === 1) {
                    // Single touch: pan or tap
                    const touch = touches[0];
                    const coords = getCanvasCoords(event);
                    touchStartPos = { x: coords.x, y: coords.y };
                    touchStartTime = Date.now();

                    if (currentTool === 'pan') {
                        mapView.dragging = true;
                        mapView.dragStartX = touch.clientX;
                        mapView.dragStartY = touch.clientY;
                        mapView.dragOriginX = mapView.centerX;
                        mapView.dragOriginY = mapView.centerY;
                    }
                    // For add/remove, we handle on touchend (tap detection)
                } else if (touches.length === 2) {
                    // Pinch
                    isPinching = true;
                    pinchStartDist = getTouchDist(event);
                    pinchStartZoom = mapView.zoom;
                    mapView.dragging = false;
                }
            }, { passive: true });

            mapCanvas.addEventListener('touchmove', function(event) {
                if (activeView !== 'map') return;
                event.preventDefault();

                const touches = event.touches;

                if (touches.length === 1 && mapView.dragging && currentTool === 'pan') {
                    const touch = touches[0];
                    const deltaX = touch.clientX - mapView.dragStartX;
                    const deltaY = touch.clientY - mapView.dragStartY;
                    mapView.centerX = mapView.dragOriginX - deltaX / mapView.zoom;
                    mapView.centerY = mapView.dragOriginY - deltaY / mapView.zoom;
                    if (activeView === 'map') renderMapView();
                } else if (touches.length === 2 && isPinching) {
                    const dist = getTouchDist(event);
                    const scale = dist / pinchStartDist;
                    const newZoom = clamp(pinchStartZoom * scale, 10, 180);
                    // Zoom toward center of pinch
                    const rect = mapCanvas.getBoundingClientRect();
                    const cx = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
                    const cy = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
                    const scaleX = mapCanvas.width / rect.width;
                    const scaleY = mapCanvas.height / rect.height;
                    const mouseX = cx * scaleX;
                    const mouseY = cy * scaleY;
                    const mouseWorld = mapScreenToWorld(mouseX, mouseY);
                    mapView.zoom = newZoom;
                    mapView.centerX = mouseWorld.x - (mouseX - mapCanvas.width / 2) / mapView.zoom;
                    mapView.centerY = mouseWorld.y - (mouseY - mapCanvas.height / 2) / mapView.zoom;
                    document.getElementById('mapZoomSlider').value = mapView.zoom;
                    document.getElementById('mapZoomValue').textContent = mapView.zoom.toFixed(0);
                    if (activeView === 'map') renderMapView();
                }
            }, { passive: false });

            mapCanvas.addEventListener('touchend', function(event) {
                if (activeView !== 'map') return;

                // If it was a tap (not a drag) and we're in add/remove mode
                if (!mapView.dragging && touchStartPos && currentTool !== 'pan') {
                    const elapsed = Date.now() - touchStartTime;
                    if (elapsed < 300) { // tap threshold
                        const world = mapScreenToWorld(touchStartPos.x, touchStartPos.y);
                        if (currentTool === 'add') {
                            addWaypoint(world.x, world.y);
                        } else if (currentTool === 'remove') {
                            removeWaypoint(world.x, world.y);
                        }
                    }
                }

                mapView.dragging = false;
                isPinching = false;
                touchStartPos = null;
            }, { passive: true });

            // Cancel drag if touch leaves canvas
            mapCanvas.addEventListener('touchcancel', function() {
                mapView.dragging = false;
                isPinching = false;
                touchStartPos = null;
            }, { passive: true });
        }

        // ── Waypoint functions ──
        function addWaypoint(x, y) {
            waypoints.push({ x, y });
            updateWaypointUI();
            if (activeView === 'map') renderMapView();
        }

        function removeWaypoint(x, y) {
            let minDist = waypointRadius + 0.01;
            let index = -1;
            waypoints.forEach((wp, i) => {
                const d = Math.hypot(wp.x - x, wp.y - y);
                if (d < minDist) { minDist = d;
                    index = i; }
            });
            if (index >= 0) {
                waypoints.splice(index, 1);
                updateWaypointUI();
                if (activeView === 'map') renderMapView();
            }
        }

        function sendPath() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected to bridge.');
                return;
            }
            ws.send(JSON.stringify({
                type: 'set_waypoints',
                waypoints: waypoints,
                loop: loopMode
            }));
        }

        function updateWaypointUI() {
            document.getElementById('waypointCount').textContent = '📍 ' + waypoints.length;
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  MOBILE D-PAD
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        function setupDpad() {
            const buttons = document.querySelectorAll('.dpad-btn');
            let activeInterval = null;

            function startCommand(cmd) {
                if (currentMode !== 'manual') return;
                sendCommand(cmd);
                // Repeat while held
                if (activeInterval) clearInterval(activeInterval);
                activeInterval = setInterval(() => {
                    if (currentMode === 'manual') {
                        sendCommand(cmd);
                    } else {
                        clearInterval(activeInterval);
                        activeInterval = null;
                    }
                }, 150);
            }

            function stopCommand() {
                if (activeInterval) {
                    clearInterval(activeInterval);
                    activeInterval = null;
                }
                // Only send stop if we're still in manual
                if (currentMode === 'manual') {
                    sendCommand('stop');
                }
            }

            buttons.forEach(btn => {
                const cmd = btn.dataset.cmd;

                // Mouse
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    if (cmd === 'stop') {
                        sendCommand('stop');
                        return;
                    }
                    startCommand(cmd);
                });
                btn.addEventListener('mouseup', stopCommand);
                btn.addEventListener('mouseleave', stopCommand);

                // Touch
                btn.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    if (cmd === 'stop') {
                        sendCommand('stop');
                        return;
                    }
                    startCommand(cmd);
                    btn.classList.add('active');
                }, { passive: false });
                btn.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    stopCommand();
                    btn.classList.remove('active');
                }, { passive: false });
                btn.addEventListener('touchcancel', (e) => {
                    stopCommand();
                    btn.classList.remove('active');
                }, { passive: true });
            });

            // Global touch cancel safety
            document.addEventListener('touchcancel', () => {
                if (activeInterval) {
                    clearInterval(activeInterval);
                    activeInterval = null;
                }
                document.querySelectorAll('.dpad-btn').forEach(b => b.classList.remove('active'));
            });
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  BOOT
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        window.addEventListener('load', function() {
            initCanvases();
            initZoomSlider();
            setupKeyboardControls();
            setupMapInteractions();
            setupDpad();

            document.querySelector('.tool-btn[data-tool="pan"]').classList.add('active');
            currentTool = 'pan';
            updateWaypointUI();

            document.getElementById('wsUrl').value = 'wss://kmo-relayserver.yudhisthereal.workers.dev';
            document.getElementById('bridgeId').value = 'my_robot_01';

            setMode('idle', true);

            document.getElementById('numPoints').innerHTML = '0';
            document.getElementById('rangeLimit').innerHTML = '0–0 m';
            document.getElementById('lastScan').innerHTML = '0 s';
            document.getElementById('scanRate').innerHTML = '0 Hz';
            document.getElementById('leftSpeed').innerHTML = '0.00 m/s';
            document.getElementById('rightSpeed').innerHTML = '0.00 m/s';
            document.getElementById('robotMode').innerHTML = 'Idle';
            document.getElementById('posX').innerHTML = '0.00 m';
            document.getElementById('posY').innerHTML = '0.00 m';
            document.getElementById('theta').innerHTML = '0.00 °';
            document.getElementById('linearVel').innerHTML = '0.00 m/s';

            updateZoomDisplay();
            showView('map');
            document.getElementById('toggleGridBtn').textContent = 'Hide Grid';

            setTimeout(() => {
                connectWebSocket();
            }, 1000);

            document.getElementById('wsUrl').addEventListener('keypress', function(event) {
                if (event.key === 'Enter') connectWebSocket();
            });
            document.getElementById('bridgeId').addEventListener('keypress', function(event) {
                if (event.key === 'Enter') connectWebSocket();
            });

            // Config inputs
            const wheelRadiusInput = document.getElementById('wheelRadius');
            const wheelBaseInput = document.getElementById('wheelBase');
            const lidarOffsetXInput = document.getElementById('lidarOffsetX');
            const lidarOffsetYInput = document.getElementById('lidarOffsetY');
            const robotWidthInput = document.getElementById('robotWidth');
            const stopDistanceInput = document.getElementById('stopDistance');
            const speedSlider = document.getElementById('maxSpeedSlider');

            function startEditing() { isEditing = true; }

            function stopEditing() { isEditing = false; }

            const inputs = [wheelRadiusInput, wheelBaseInput, lidarOffsetXInput, lidarOffsetYInput, robotWidthInput,
                stopDistanceInput
            ];
            inputs.forEach(input => {
                input.addEventListener('focus', startEditing);
                input.addEventListener('blur', stopEditing);
            });

            speedSlider.addEventListener('pointerdown', startEditing);
            speedSlider.addEventListener('pointerup', stopEditing);
            speedSlider.addEventListener('focus', startEditing);
            speedSlider.addEventListener('blur', stopEditing);
            document.addEventListener('pointerup', stopEditing);

            wheelRadiusInput.addEventListener('input', () => { updateLinearSpeed();
                sendConfig(); });
            wheelBaseInput.addEventListener('input', sendConfig);
            lidarOffsetXInput.addEventListener('input', sendConfig);
            lidarOffsetYInput.addEventListener('input', sendConfig);
            robotWidthInput.addEventListener('input', sendConfig);
            stopDistanceInput.addEventListener('input', sendConfig);

            speedSlider.addEventListener('input', function() {
                document.getElementById('maxSpeedDisplay').textContent = parseFloat(this.value).toFixed(1);
                sendConfig();
                updateLinearSpeed();
            });

            updateLinearSpeed();

            // Handle window resize
            let resizeTimer;
            window.addEventListener('resize', function() {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    if (activeView === 'radar') renderRadarView();
                    else if (activeView === 'map') renderMapView();
                }, 150);
            });

            // Orientation change
            window.addEventListener('orientationchange', function() {
                setTimeout(() => {
                    if (activeView === 'radar') renderRadarView();
                    else if (activeView === 'map') renderMapView();
                }, 300);
            });
        });