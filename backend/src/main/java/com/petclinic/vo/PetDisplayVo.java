package com.petclinic.vo;

import lombok.Data;

/**
 * 历史业务记录（预约/病历/问诊）里回显宠物用的展示字段投影：
 * 只有昵称、种类、品种、头像，且经 {@code PetMapper.selectHistoryDisplay} 读取，
 * 含已逻辑删除的档案。刻意不是完整 Pet——旧记录只需要展示，不能拿去做写入。
 */
@Data
public class PetDisplayVo {

    private Long id;
    private String name;
    private String species;
    private String breed;
    private String avatar;
}
