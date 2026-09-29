# Hướng dẫn sử dụng GHN Ticket Bot (người dùng lần đầu)

2026-09-22 · soạn bởi MyTran1806

## 1. Bot này là gì?

**GHN Ticket Bot** là một script (Tampermonkey) chạy ngay trong trình duyệt, giúp tự động xử lý các phiếu sự cố trên hệ thống nội bộ `noibo.ghn.vn`. Bot **không gọi API, không cần nhập token** — nó chỉ đọc thông tin hiển thị trên màn hình và tự bấm các nút y như người dùng thật.

Bot tự nhận diện và xử lý 3 loại phiếu:

| Loại phiếu | Bot làm gì |
| --- | --- |
| Đơn hàng bị quá hạn toàn trình | Kiểm tra trạng thái đơn, tự kết luận **Không truy thu** nếu đơn đã giao/trả thành công hoặc đủ điều kiện |
| Không giao/lấy/trả đúng số lần quy định | Kiểm tra trạng thái đơn; nếu đơn thuộc nhóm hoàn và phiếu **quá hạn giải trình**, bot tự tính tiền đền bù, gửi comment và chuyển người xử lý |
| Khách đã nhận hàng COD nhưng chưa tích giao thành công | Kiểm tra trạng thái đơn, tự kết luận **Không truy thu** nếu đơn đã giao thành công |

Với các trường hợp không rõ ràng, bot **không tự quyết** mà để nguyên cho CS xử lý tay (đánh dấu "CS theo dõi" / "CS check lại").

## 2. Cài đặt (chỉ làm 1 lần)

| Bước | Việc cần làm |
| --- | --- |
| 1 | Cài extension **Tampermonkey** cho trình duyệt (Chrome/Edge/Cốc Cốc) từ Chrome Web Store, nếu máy chưa có |
| 2 | Bấm vào link cài script: `https://raw.githubusercontent.com/MyTran1806/Clear-Task/main/ghn-ticket-bot.user.js` |
| 3 | Trình duyệt tự mở tab cài đặt của Tampermonkey, hiện nội dung script |
| 4 | Bấm nút **Install** (góc trên bên phải) |
| 5 | Vào lại `noibo.ghn.vn`, tải lại trang — nếu thấy bảng điều khiển màu cam hiện ở góc phải màn hình là cài thành công |

**Yêu cầu trước khi chạy bot:** phải đã đăng nhập sẵn cả hai trang `noibo.ghn.vn` và `tracuunoibo.ghn.vn` trên cùng trình duyệt (bạn đang dùng để tra cứu đơn hàng — bot cần phiên đăng nhập này để đọc được dữ liệu, không tự đăng nhập giúp bạn).

## 3. Giải thích bảng điều khiển

Bảng màu cam "GHN Ticket Bot" chỉ hiện khi đang ở trang danh sách phiếu hoặc trang chi tiết 1 phiếu trong `noibo.ghn.vn`.

| Mục trong bảng | Công dụng |
| --- | --- |
| **View đã lưu** | Lưu lại bộ lọc danh sách phiếu bạn hay dùng (ví dụ "Phiếu của tôi") để lần sau chọn nhanh, khỏi phải lọc lại tay |
| **Chế độ xem trước (dry run)** | Tích vào để bot chỉ **mô phỏng** kết quả sẽ làm gì, không thực sự bấm/gửi gì trên hệ thống — **nên dùng trước mọi lần chạy thật** |
| **Chỉ chạy ... phiếu đầu tiên** | Giới hạn số phiếu xử lý trong 1 lượt — để trống = chạy hết toàn bộ phiếu trong view |
| **Nút Bắt đầu** | Bắt đầu 1 lượt chạy mới (chỉ bấm được từ trang danh sách phiếu) |
| **Nút Dừng** | Yêu cầu dừng — bot sẽ hoàn tất nốt phiếu đang xử lý rồi mới dừng hẳn |
| **Nút Reset đã xử lý** | Xóa đánh dấu "đã xử lý" của tất cả phiếu — dùng khi muốn bot quét lại toàn bộ từ đầu |
| **Nút Tải kết quả (CSV)** | Xuất file Excel liệt kê tất cả phiếu đã xử lý trong lượt gần nhất (file cũng tự tải khi lượt chạy thật kết thúc) |
| **Ô log phía dưới** | Nhật ký theo thời gian thực — bot đang làm gì, phiếu nào, kết quả ra sao |

Bấm dấu **—** ở góc trên bảng để thu gọn/mở rộng bảng, không che khuất màn hình làm việc.

## 4. Chạy lần đầu tiên

1. Vào trang danh sách phiếu sự cố trên `noibo.ghn.vn`, lọc theo view bạn muốn bot xử lý
2. **Tích vào ô "Chế độ xem trước"** — bắt buộc cho lần chạy đầu tiên, để xem bot **sẽ** làm gì mà chưa thật sự đụng vào dữ liệu
3. Gõ số 3–5 vào ô "Chỉ chạy ... phiếu đầu tiên" để thử với một nhóm nhỏ trước
4. Bấm **Bắt đầu**, để yên tab đó (không đóng, không thu nhỏ hẳn) — bot sẽ tự chuyển qua từng phiếu
5. Đọc ô log để xem bot đã đọc được trạng thái đơn và sẽ kết luận như thế nào cho từng phiếu — đối chiếu vài phiếu với thực tế để yên tâm trước khi chạy thật
6. Khi ổn, bỏ tích "Chế độ xem trước", xóa giới hạn số phiếu (để trống = chạy hết), bấm **Bắt đầu** lại để chạy thật
7. Kết thúc lượt, bot tự tải file CSV kết quả về máy — mở ra kiểm tra lại các phiếu đã "Kết luận" hoặc "Comment + chuyển người xử lý"

## 5. Lưu ý an toàn quan trọng

- **Bot tự kết luận phiếu và gửi comment/đổi tiền đền bù thật** khi chạy ở chế độ thật (không tích xem trước) — luôn thử "Xem trước" trước, nhất là khi mới dùng lần đầu hoặc sau khi có bản cập nhật mới
- **Đừng thu nhỏ/che kín hoàn toàn cửa sổ trình duyệt** khi bot đang chạy — tab bị ẩn hoàn toàn có thể khiến trình duyệt làm chậm bot; che một phần (ví dụ để làm việc khác ở cửa sổ khác) thì không sao
- **Đăng nhập sẵn `tracuunoibo.ghn.vn`** trước khi chạy — nếu chưa đăng nhập, bot sẽ báo lỗi và tự dừng toàn bộ lượt chạy để tránh đoán sai
- **Chỉ 1 người/1 tab nên điều khiển 1 lượt chạy** — nếu mở nhiều tab `noibo.ghn.vn` cùng lúc, chỉ tab đã bấm "Bắt đầu" mới điều khiển, các tab khác không bị ảnh hưởng
- **Luôn kiểm tra lại file CSV** sau mỗi lượt chạy thật — đặc biệt các dòng "Kết luận" và "Comment + chuyển người xử lý", vì đây là các thao tác khó đảo ngược trên hệ thống
- Phiếu bị bot báo **lỗi** hoặc xếp vào **"CS theo dõi/CS check lại"** không bị bỏ quên — vẫn cần người xử lý tay bình thường

## 6. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách khắc phục |
| --- | --- | --- |
| Không thấy bảng điều khiển màu cam | Chưa cài script, hoặc đang ở sai trang | Kiểm tra Tampermonkey đã bật script, đang ở đúng `noibo.ghn.vn/ghn-ticket` |
| Log báo "Không nhận được kết quả từ trang tra cứu" | Chưa đăng nhập `tracuunoibo.ghn.vn`, hoặc trình duyệt đang chặn tab nền | Đăng nhập lại `tracuunoibo.ghn.vn` rồi bấm Bắt đầu lại; nếu vẫn lỗi, thử tắt popup-blocker cho `noibo.ghn.vn` |
| Lượt chạy tự dừng giữa chừng | Không tra cứu được trạng thái đơn (lỗi hệ thống, mất đăng nhập) | Khắc phục nguyên nhân (thường là đăng nhập), bấm Bắt đầu lại — phiếu chưa xử lý sẽ tự tiếp tục |
| Một phiếu báo lỗi riêng lẻ | Trang tải chậm, giao diện đổi khác thường ở phiếu đó | Xem chi tiết lỗi trong log/CSV, xử lý tay phiếu đó; lần chạy sau bot sẽ thử lại nếu chưa được đánh dấu đã xong |
| Muốn quét lại phiếu đã xử lý trước đó | Bot đã đánh dấu "đã xử lý" nên bỏ qua | Bấm **Reset đã xử lý** trước khi chạy lại |
| Không chắc bot có đang dùng đúng phiên bản mới nhất | Tampermonkey chưa tự kiểm tra cập nhật | Vào Tampermonkey Dashboard → mục script → **Check for userscript updates** |

Nếu gặp lỗi không có trong bảng trên, chụp lại ô log và gửi cho người quản lý script để kiểm tra.

## 7. Bot tự cập nhật như thế nào?

Sau khi đã cài một lần, bạn **không cần bấm lại link cài đặt**. Tampermonkey tự định kỳ kiểm tra phiên bản mới từ link trên GitHub và tự cập nhật.

Nếu muốn cập nhật ngay không chờ: mở Tampermonkey → **Dashboard** → tìm script "Auto xử lý phiếu sự cố" → bấm biểu tượng **Check for userscript updates** (mũi tên xoay tròn).

Có thể kiểm tra đang dùng bản nào bằng cách nhìn số phiên bản (ví dụ `v3.8.0`) ngay trên thanh tiêu đề của bảng điều khiển màu cam.
