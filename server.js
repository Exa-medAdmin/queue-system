// server.js - Railway Version with SQLite Database
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ตรวจสอบและสร้างโฟลเดอร์ data ถ้าไม่มี
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data');
}

// Database Setup
const db = new sqlite3.Database('./data/queue.db');

// ฟังก์ชันเริ่มต้น Database
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // ตาราง queues - เก็บข้อมูลคิวทั้งหมด
      db.run(`CREATE TABLE IF NOT EXISTS queues (
        id INTEGER PRIMARY KEY,
        queue_number INTEGER UNIQUE,
        status TEXT DEFAULT 'รอ',
        service_channel TEXT,
        called_time TEXT,
        finished_time TEXT
      )`, (err) => {
        if (err) {
          console.error('Error creating queues table:', err);
          reject(err);
          return;
        }
      });

      // ตาราง service_channels - เก็บสถานะช่องบริการ
      db.run(`CREATE TABLE IF NOT EXISTS service_channels (
        id INTEGER PRIMARY KEY,
        channel_name TEXT UNIQUE,
        current_queue INTEGER,
        is_active BOOLEAN DEFAULT FALSE
      )`, (err) => {
        if (err) {
          console.error('Error creating service_channels table:', err);
          reject(err);
          return;
        }
      });

      // ตาราง history - เก็บประวัติการทำงาน
      db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_number INTEGER,
        service_channel TEXT,
        action TEXT,
        timestamp TEXT,
        details TEXT
      )`, (err) => {
        if (err) {
          console.error('Error creating history table:', err);
          reject(err);
          return;
        }
      });

      // เริ่มต้นข้อมูลช่องบริการ
      const channels = ['ช่องบริการ 1', 'ช่องบริการ 2', 'ช่องบริการ 3', 
                       'ช่องบริการ 4', 'ช่องบริการ 5', 'ช่องบริการ 6'];
      
      const stmt = db.prepare(`INSERT OR IGNORE INTO service_channels (channel_name, current_queue, is_active) 
                              VALUES (?, NULL, FALSE)`);
      
      channels.forEach(channel => {
        stmt.run(channel);
      });
      stmt.finalize();

      console.log('✅ Database initialized successfully');
      resolve();
    });
  });
}

// ฟังก์ชันเริ่มต้นคิว 1-1500
function initializeQueues() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM queues', (err) => {
      if (err) {
        reject(err);
        return;
      }

      const stmt = db.prepare(`INSERT INTO queues (queue_number, status) VALUES (?, 'รอ')`);
      
      for (let i = 1; i <= 1500; i++) {
        stmt.run(i);
      }
      
      stmt.finalize((err) => {
        if (err) {
          reject(err);
          return;
        }
        console.log('✅ Created queues 1-1500');
        resolve();
      });
    });
  });
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// API: ดูสถานะคิวปัจจุบันทั้งหมด
app.get('/api/queue-status', (req, res) => {
  const query = `
    SELECT channel_name, current_queue, is_active 
    FROM service_channels 
    ORDER BY channel_name
  `;
  
  db.all(query, (err, channels) => {
    if (err) {
      console.error('Error getting queue status:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
    }

    // นับคิวที่รออยู่
    db.get(`SELECT COUNT(*) as waiting FROM queues WHERE status = 'รอ'`, (err, waitingResult) => {
      if (err) {
        console.error('Error counting waiting queues:', err);
        return res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
      }

      const serviceChannels = {};
      channels.forEach(channel => {
        serviceChannels[channel.channel_name] = {
          currentQueue: channel.current_queue,
          isActive: channel.is_active === 1
        };
      });

      res.json({
        serviceChannels,
        waitingQueues: waitingResult.waiting,
        totalQueues: 1500,
        timestamp: new Date().toLocaleString('th-TH')
      });
    });
  });
});

// API: ดูสถานะคิวของช่องบริการเฉพาะ
app.get('/api/queue-status/:serviceChannel', (req, res) => {
  const serviceChannel = decodeURIComponent(req.params.serviceChannel);
  
  const query = `SELECT current_queue, is_active FROM service_channels WHERE channel_name = ?`;
  
  db.get(query, [serviceChannel], (err, row) => {
    if (err) {
      console.error('Error getting channel status:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
    }

    if (!row) {
      return res.status(404).json({ error: 'ไม่พบช่องบริการที่ระบุ' });
    }

    res.json({
      currentQueue: row.current_queue || 'ว่าง',
      isActive: row.is_active === 1
    });
  });
});

// API: เรียกคิวถัดไป
app.post('/api/call-next-queue', (req, res) => {
  const { serviceChannel } = req.body;
  
  if (!serviceChannel) {
    return res.status(400).json({ error: 'ไม่ได้ระบุช่องบริการ' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // 1. เปลี่ยนสถานะคิวเก่าให้เป็น "เสร็จสิ้น"
    const updateOldQueue = `
      UPDATE queues 
      SET status = 'เสร็จสิ้น', finished_time = datetime('now', 'localtime')
      WHERE queue_number = (
        SELECT current_queue FROM service_channels WHERE channel_name = ?
      ) AND status = 'กำลังใช้บริการ'
    `;

    db.run(updateOldQueue, [serviceChannel], function(err) {
      if (err) {
        console.error('Error updating old queue:', err);
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตคิวเก่า' });
      }

      // 2. หาคิวรอตัวถัดไป
      const findNextQueue = `
        SELECT queue_number FROM queues 
        WHERE status = 'รอ' 
        ORDER BY queue_number ASC 
        LIMIT 1
      `;

      db.get(findNextQueue, (err, nextQueue) => {
        if (err) {
          console.error('Error finding next queue:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการหาคิวถัดไป' });
        }

        if (!nextQueue) {
          // ไม่มีคิวรออยู่
          const updateChannel = `
            UPDATE service_channels 
            SET current_queue = NULL, is_active = FALSE 
            WHERE channel_name = ?
          `;

          db.run(updateChannel, [serviceChannel], (err) => {
            if (err) {
              console.error('Error updating channel (no queue):', err);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
            }

            db.run('COMMIT');
            res.json({ 
              success: false, 
              message: 'ไม่มีคิวรออยู่ขณะนี้'
            });
          });
          return;
        }

        // 3. อัปเดตคิวใหม่
        const updateNewQueue = `
          UPDATE queues 
          SET status = 'กำลังใช้บริการ', 
              service_channel = ?, 
              called_time = datetime('now', 'localtime')
          WHERE queue_number = ?
        `;

        db.run(updateNewQueue, [serviceChannel, nextQueue.queue_number], function(err) {
          if (err) {
            console.error('Error updating new queue:', err);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตคิวใหม่' });
          }

          // 4. อัปเดตช่องบริการ
          const updateChannel = `
            UPDATE service_channels 
            SET current_queue = ?, is_active = TRUE 
            WHERE channel_name = ?
          `;

          db.run(updateChannel, [nextQueue.queue_number, serviceChannel], (err) => {
            if (err) {
              console.error('Error updating service channel:', err);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตช่องบริการ' });
            }

            // 5. บันทึกประวัติ
            const insertHistory = `
              INSERT INTO history (queue_number, service_channel, action, timestamp, details)
              VALUES (?, ?, 'เรียกคิว', datetime('now', 'localtime'), 'เรียกคิวเข้าให้บริการ')
            `;

            db.run(insertHistory, [nextQueue.queue_number, serviceChannel], (err) => {
              if (err) {
                console.error('Error inserting history:', err);
                // ไม่ rollback เพราะ history ไม่สำคัญมาก
              }

              db.run('COMMIT');
              res.json({ 
                success: true, 
                queueNumber: nextQueue.queue_number,
                message: `เรียกคิว ${nextQueue.queue_number} สำหรับ${serviceChannel} เรียบร้อยแล้ว`
              });
            });
          });
        });
      });
    });
  });
});

// API: รีเซ็ตคิวทั้งหมด
app.post('/api/reset-all-queues', async (req, res) => {
  const { confirmationCode } = req.body;
  
  if (confirmationCode !== '12345') {
    return res.status(400).json({ error: 'รหัสยืนยันไม่ถูกต้อง' });
  }

  try {
    await initializeQueues();
    
    // รีเซ็ตช่องบริการทั้งหมด
    db.run(`UPDATE service_channels SET current_queue = NULL, is_active = FALSE`, (err) => {
      if (err) {
        console.error('Error resetting channels:', err);
        return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ตช่องบริการ' });
      }

      // บันทึกประวัติ
      const insertHistory = `
        INSERT INTO history (action, timestamp, details)
        VALUES ('รีเซ็ตระบบ', datetime('now', 'localtime'), 'รีเซ็ตคิวทั้งหมด 1-1500')
      `;

      db.run(insertHistory, (err) => {
        if (err) {
          console.error('Error inserting reset history:', err);
        }

        res.json({ 
          success: true, 
          message: 'รีเซ็ตระบบเรียบร้อยแล้ว สร้างคิว 1-1500 ใหม่' 
        });
      });
    });
  } catch (error) {
    console.error('Error resetting queues:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ตระบบ' });
  }
});

// API: กู้คืนสถานะระบบ (ทับคิวเก่า)
app.post('/api/restore-queues', async (req, res) => {
  const { channels } = req.body;
  
  if (!channels || typeof channels !== 'object') {
    return res.status(400).json({ error: 'ข้อมูลช่องบริการไม่ถูกต้อง' });
  }

  try {
    // รีเซ็ตระบบก่อน
    await initializeQueues();

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // รีเซ็ตช่องบริการทั้งหมด
      db.run(`UPDATE service_channels SET current_queue = NULL, is_active = FALSE`, (err) => {
        if (err) {
          console.error('Error resetting channels for restore:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ต' });
        }

        // กู้คืนสถานะตามที่ระบุ
        let processedChannels = 0;
        const channelEntries = Object.entries(channels).filter(([channel, queue]) => queue > 0);
        
        if (channelEntries.length === 0) {
          db.run('COMMIT');
          return res.json({ 
            success: true, 
            message: 'รีเซ็ตระบบเรียบร้อยแล้ว (ไม่มีข้อมูลกู้คืน)'
          });
        }

        channelEntries.forEach(([channelName, queueNumber]) => {
          if (queueNumber >= 1 && queueNumber <= 1500) {
            // อัปเดตคิวที่ระบุให้เป็น "กำลังใช้บริการ"
            const updateQueue = `
              UPDATE queues 
              SET status = 'กำลังใช้บริการ', 
                  service_channel = ?, 
                  called_time = datetime('now', 'localtime')
              WHERE queue_number = ?
            `;

            db.run(updateQueue, [channelName, queueNumber], (err) => {
              if (err) {
                console.error('Error updating restored queue:', err);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนคิว' });
              }

              // อัปเดตช่องบริการ
              const updateChannel = `
                UPDATE service_channels 
                SET current_queue = ?, is_active = TRUE 
                WHERE channel_name = ?
              `;

              db.run(updateChannel, [queueNumber, channelName], (err) => {
                if (err) {
                  console.error('Error updating restored channel:', err);
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนช่องบริการ' });
                }

                // ตั้งคิวก่อนหน้าให้เป็น "เสร็จสิ้น"
                const updatePreviousQueues = `
                  UPDATE queues 
                  SET status = 'เสร็จสิ้น', finished_time = datetime('now', 'localtime')
                  WHERE queue_number < ? AND status = 'รอ'
                `;

                db.run(updatePreviousQueues, [queueNumber], (err) => {
                  if (err) {
                    console.error('Error updating previous queues:', err);
                  }

                  processedChannels++;
                  
                  // เมื่อประมวลผลครบทุกช่องแล้ว
                  if (processedChannels === channelEntries.length) {
                    // บันทึกประวัติ
                    const insertHistory = `
                      INSERT INTO history (action, timestamp, details)
                      VALUES ('กู้คืนสถานะระบบ', datetime('now', 'localtime'), ?)
                    `;

                    db.run(insertHistory, [JSON.stringify(channels)], (err) => {
                      if (err) {
                        console.error('Error inserting restore history:', err);
                      }

                      db.run('COMMIT');
                      res.json({ 
                        success: true, 
                        message: 'กู้คืนสถานะระบบเรียบร้อยแล้ว',
                        restoredChannels: channels
                      });
                    });
                  }
                });
              });
            });
          } else {
            processedChannels++;
            
            if (processedChannels === channelEntries.length) {
              db.run('COMMIT');
              res.json({ 
                success: true, 
                message: 'กู้คืนสถานะระบบเรียบร้อยแล้ว',
                restoredChannels: channels
              });
            }
          }
        });
      });
    });
  } catch (error) {
    console.error('Error restoring queues:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนระบบ' });
  }
});

// API: ประวัติการทำงาน
app.get('/api/history', (req, res) => {
  const query = `
    SELECT * FROM history 
    ORDER BY timestamp DESC 
    LIMIT 50
  `;
  
  db.all(query, (err, rows) => {
    if (err) {
      console.error('Error getting history:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงประวัติได้' });
    }
    
    res.json(rows);
  });
});

// API: สถิติระบบ
app.get('/api/statistics', (req, res) => {
  const queries = {
    completed: `SELECT COUNT(*) as count FROM queues WHERE status = 'เสร็จสิ้น'`,
    inProgress: `SELECT COUNT(*) as count FROM queues WHERE status = 'กำลังใช้บริการ'`,
    waiting: `SELECT COUNT(*) as count FROM queues WHERE status = 'รอ'`,
    activeChannels: `SELECT COUNT(*) as count FROM service_channels WHERE is_active = TRUE`
  };

  let results = {};
  let completed = 0;
  const total = Object.keys(queries).length;

  Object.entries(queries).forEach(([key, query]) => {
    db.get(query, (err, row) => {
      if (err) {
        console.error(`Error getting ${key} statistics:`, err);
        results[key] = 0;
      } else {
        results[key] = row.count;
      }

      completed++;
      
      if (completed === total) {
        res.json({
          totalQueues: 1500,
          completed: results.completed,
          inProgress: results.inProgress,
          waiting: results.waiting,
          activeChannels: results.activeChannels,
          lastUpdate: new Date().toLocaleString('th-TH')
        });
      }
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

// Initialize and start server
async function startServer() {
  try {
    await initializeDatabase();
    
    // ตรวจสอบว่ามีคิวในฐานข้อมูลหรือไม่
    db.get('SELECT COUNT(*) as count FROM queues', async (err, row) => {
      if (err) {
        console.error('Error checking queues:', err);
        return;
      }

      if (row.count === 0) {
        console.log('🔄 No queues found, initializing...');
        await initializeQueues();
      } else {
        console.log(`📊 Found ${row.count} queues in database`);
      }

      app.listen(port, () => {
        console.log(`🚀 Queue System is running on port ${port}`);
        console.log(`📊 Display: http://localhost:${port}/display`);
        console.log(`🎛️ Control: http://localhost:${port}/control`);
        console.log(`⚙️ Admin: http://localhost:${port}/`);
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('✅ Database connection closed');
    }
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down...');
  db.close(() => {
    process.exit(0);
  });
});

startServer();