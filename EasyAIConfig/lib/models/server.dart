/// 单个远程服务配置。多服务管理的基本单元。
class ServerConfig {
  final String id;
  String name;
  String baseUrl;
  String token;

  ServerConfig({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.token,
  });

  ServerConfig copyWith({String? name, String? baseUrl, String? token}) =>
      ServerConfig(
        id: id,
        name: name ?? this.name,
        baseUrl: baseUrl ?? this.baseUrl,
        token: token ?? this.token,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'token': token,
      };

  static ServerConfig? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = (raw['id'] ?? '').toString();
    final baseUrl = (raw['baseUrl'] ?? '').toString();
    final token = (raw['token'] ?? '').toString();
    if (id.isEmpty || baseUrl.isEmpty || token.isEmpty) return null;
    final name = (raw['name'] ?? '').toString();
    return ServerConfig(
      id: id,
      name: name.isEmpty ? _hostLabel(baseUrl) : name,
      baseUrl: baseUrl,
      token: token,
    );
  }

  /// 从 baseUrl 提炼一个易读的默认名字（host:port）。
  static String _hostLabel(String baseUrl) {
    try {
      final u = Uri.parse(baseUrl);
      final port = u.hasPort ? ':${u.port}' : '';
      final host = u.host.isNotEmpty ? u.host : baseUrl;
      return '$host$port';
    } catch (_) {
      return baseUrl;
    }
  }

  static String defaultName(String baseUrl) => _hostLabel(baseUrl);
}
