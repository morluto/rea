@echo off
rem Pcap tool stub for Windows: emulates tshark --version and field output.
rem %1 is the first argument; the capture path arrives as %2 for -r/-c.

if "%~1"=="--version" (
    echo TShark ^(Wireshark^) 4.6.6-windows-stub
    exit /b 0
)

if not "%~1"=="-n" exit /b 2
if not "%~2"=="-r" exit /b 2
if not "%~4"=="-T" exit /b 2
if not "%~5"=="json" exit /b 2

rem Emit the same JSON as the POSIX stub
echo [{"_source":{"layers":{"frame.number":["1"],"frame.protocols":["eth:ethertype:ip:udp:dns"],"ip.src":["192.168.1.100"],"ip.dst":["8.8.8.8"],"dns.qry.name":["api.example.com"],"dns.flags.response":["1"],"dns.a":["93.184.216.34"]}}},{"_source":{"layers":{"frame.number":["2"],"frame.protocols":["eth:ethertype:ip:tcp:tls"],"ip.src":["192.168.1.100"],"ip.dst":["93.184.216.34"],"tls.handshake.extensions_server_name":["api.example.com"]}}},{"_source":{"layers":{"frame.number":["3"],"frame.protocols":["eth:ethertype:ip:tcp:http"],"ip.src":["192.168.1.100"],"ip.dst":["93.184.216.34"],"http.request.full_uri":["http://api.example.com/v1/data"]}}}]
exit /b 0
