package com.yuzhua.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 品牌配置，对应 application.yml 的 yuzhua.brand.* 节点。
 *
 * <p>后端品牌文案的单一事实源：接口文档等需要展示品牌名的地方统一从这里取值。
 */
@Data
@ConfigurationProperties(prefix = "yuzhua.brand")
public class BrandProperties {

    /** 产品正式全名 */
    private String fullName = "愈爪|宠物医院预约与在线问诊平台";
}